const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('HIU requests are hospital-scoped and encrypted key blobs are portable', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'models', 'AbdmHiuRequest.js'), 'utf8');
  const topLevelHospital = source.indexOf("hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true");
  const requestId = source.indexOf("requestId: { type: String, required: true");
  const encryptedSchemaEnd = source.indexOf("{ _id: false }");

  assert.ok(topLevelHospital > encryptedSchemaEnd, 'hospitalId must be on the HIU request, not inside the encrypted blob');
  assert.ok(topLevelHospital < requestId, 'hospitalId must be declared before request fields');
  assert.match(source, /encryptedPrivateMaterial:\s*\{ type: encryptedBlobSchema, select: false \}/);
  assert.doesNotMatch(source.slice(0, encryptedSchemaEnd), /hospitalId/);
});
