function validateOrderedTimestamps(record, keys, label) {
  let previous = null;
  for (const key of keys) {
    const value = record[key];
    if (!value) continue;
    const current = new Date(value);
    if (Number.isNaN(current.getTime())) throw Object.assign(new Error(`${label}: ${key} is not a valid date/time`), { statusCode: 400 });
    if (previous && current < previous.date) throw Object.assign(new Error(`${label}: ${key} cannot be before ${previous.key}`), { statusCode: 409 });
    previous = { key, date: current };
  }
}

function validateClinicalPayload(kind, payload = {}) {
  if (kind === 'anesthesia') validateOrderedTimestamps(payload, ['inductionAt', 'intubationAt', 'incisionAt', 'closureAt', 'extubationAt'], 'Anaesthesia timeline');
  if (kind === 'operative') validateOrderedTimestamps(payload, ['surgeryDate', 'incisionAt', 'closureAt'], 'Operative timeline');
  if (kind === 'recovery') validateOrderedTimestamps(payload, ['receivedAt', 'transferAt'], 'Recovery timeline');
}

module.exports = { validateOrderedTimestamps, validateClinicalPayload };
