const assert = require('assert');
const { clinicalContext, clinicalDayBounds } = require('../utils/clinicalDate');
const { EWS_CONFIG } = require('../config/clinicalScoring');
const { getPermission } = require('../middlewares/auth');

// 05:59 IST belongs to prior chart day; 06:00 begins a new day.
assert.strictEqual(
  clinicalContext(new Date('2026-07-03T00:29:00.000Z'), 'Asia/Kolkata').chartDate,
  '2026-07-02'
);

assert.strictEqual(
  clinicalContext(new Date('2026-07-03T00:30:00.000Z'), 'Asia/Kolkata').chartDate,
  '2026-07-03'
);

const bounds = clinicalDayBounds('2026-07-03', 'Asia/Kolkata');
assert.strictEqual(bounds.start.toISOString(), '2026-07-03T00:30:00.000Z');
assert.strictEqual(bounds.end.toISOString(), '2026-07-04T00:30:00.000Z');

const ews = EWS_CONFIG.score({
  respiratoryRate: 30,
  spo2: 90,
  pulse: 135,
  systolicBP: 88,
  temperatureF: 103,
  consciousnessResponse: 'Voice',
  noUrineOverSixHours: true
});

assert.ok(
  Object.values(ews).reduce((total, score) => total + score, 0) >= EWS_CONFIG.escalationTotal
);

assert.strictEqual(
  getPermission(
    { role: 'nurse', modulePermissions: [{ moduleKey: 'ipd.vitals', access: 'edit', actions: [] }] },
    'ipd.vitals'
  ).access,
  'manage'
);

assert.strictEqual(
  getPermission(
    { role: 'nurse', modulePermissions: [] },
    'pharmacy.clearance'
  ).access,
  'view'
);

console.log('Final-change non-DB tests passed');