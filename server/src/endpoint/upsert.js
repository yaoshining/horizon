'use strict';

const check = require('../error').check;
const upsert = require('../schema/horizon_protocol').upsert;
const reql_options = require('./common').reql_options;
const writes = require('./writes');

const Joi = require('joi');
const r = require('rethinkdb');

const run = (raw_request, context, ruleset, metadata, send, done) => {
  const parsed = Joi.validate(raw_request.options, upsert);
  if (parsed.error !== null) { throw new Error(parsed.error.details[0].message); }

  const collection = metadata.collection(parsed.value.collection);
  const conn = metadata.connection();
  const response_data = [ ];

  r.expr(parsed.value.data)
    .map((new_row) =>
      r.branch(new_row.hasFields('id'),
               collection.table.get(new_row('id')).do((old_row) =>
                 r.branch(old_row.eq(null),
                          [ null, new_row ],
                          [ old_row, old_row.merge(new_row) ])),
               [ null, new_row ]))
    .run(conn, reql_options)
    .then((changes) => {
      check(changes.length === parsed.value.data.length, 'Unexpected ReQL response size.');
      const valid_rows = [ ];
      for (let i = 0; i < changes.length; ++i) {
        if (!ruleset.validate(context, changes[i][0], changes[i][1])) {
          response_data.push(new Error(writes.unauthorized_error));
        } else {
          const new_version = parsed.value.data[i][writes.version_field];
          if (changes[i][0] === null) {
            if (new_version !== undefined) {
              response_data.push(new Error(writes.invalidated_error));
            } else {
              valid_rows.push(parsed.value.data[i]);
              response_data.push(null);
            }
          } else {
            const old_version = changes[i][0][writes.version_field];
            if (new_version === undefined) {
              parsed.value.data[i][writes.version_field] =
                old_version === undefined ? -1 : old_version;
            }
            valid_rows.push(parsed.value.data[i]);
            response_data.push(null);
          }
        }
      }

      return r.expr(valid_rows)
               .forEach((new_row) =>
                 r.branch(new_row.hasFields('id'),
                          collection.table.get(new_row('id')).replace((old_row) =>
                              r.branch(
                                old_row.eq(null),
                                r.branch(
                                  // Error if we were expecting the row to exist
                                  new_row.hasFields(writes.version_field),
                                  r.error(writes.invalidated_error),

                                  // Otherwise, insert the row
                                  writes.apply_version(new_row, 0)
                                ),
                                r.branch(
                                  // The row may have changed from the expected version
                                  old_row(writes.version_field).default(-1).ne(new_row(writes.version_field)),
                                  r.error(writes.invalidated_error),

                                  // Otherwise, we can safely update the row and increment the version
                                  writes.apply_version(old_row.merge(new_row), old_row(writes.version_field).default(-1).add(1))
                                )
                              ), { returnChanges: 'always' }),

                          // The new row did not have an id, so we insert it with an autogen id
                          collection.table.insert(writes.apply_version(new_row, 0),
                                                  { returnChanges: 'always' })))
               .run(conn, reql_options);
    }).then((upsert_results) => {
      done(writes.make_write_response(response_data, upsert_results));
    }).catch(done);
};

module.exports = { run };
