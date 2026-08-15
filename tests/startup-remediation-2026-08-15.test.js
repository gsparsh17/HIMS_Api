'use strict';

const assert = require('assert');
const { unwrapId, normalizeObjectId } = require('../utils/hospitalScope');
const { redactMongoUri } = require('../config/db');
const { lookbackStart } = require('../jobs/ipdRecurringChargeJob');

const id = '69a697c0df37f940dd7906ce';

assert.strictEqual(String(unwrapId(`{\n  "$oid": "${id}"\n}`)), id);
assert.strictEqual(String(unwrapId({ $oid: id })), id);
assert.strictEqual(String(unwrapId(`ObjectId("${id}")`)), id);
assert.strictEqual(String(normalizeObjectId(`{"$oid":"${id}"}`)), id);
assert.strictEqual(normalizeObjectId('not-an-object-id'), null);

const redacted = redactMongoUri('mongodb://user:secret@db1.example:27017,db2.example:27017/test?authSource=admin');
assert(!redacted.includes('secret'));
assert(!redacted.includes('user:secret'));
assert(redacted.includes('***'));

const now = Date.now();
const from = lookbackStart(2).getTime();
assert(from <= now);
assert(from >= now - (86400000 + 5000));

console.log('startup-remediation tests passed');
