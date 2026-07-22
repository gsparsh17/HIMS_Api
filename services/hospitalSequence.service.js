const HospitalSequence = require('../models/HospitalSequence');

async function nextSequence(hospitalId, key, session) {
  const sequence = await HospitalSequence.findOneAndUpdate(
    { hospitalId, key },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return sequence.value;
}

function financialYear(date = new Date()) {
  const month = date.getMonth() + 1;
  const start = month >= 4 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

async function nextNumber(hospitalId, key, prefix, session) {
  const value = await nextSequence(hospitalId, key, session);
  return `${prefix}/${financialYear()}/${String(value).padStart(6, '0')}`;
}

module.exports = { nextSequence, nextNumber, financialYear };
