const FinancialSequence = require('../models/FinancialSequence');

const PREFIXES = {
  BILL: 'BIL',
  INVOICE: 'INV',
  RECEIPT: 'RCP',
  ADVANCE_RECEIPT: 'ADV',
  ADVANCE_REFUND: 'ARF',
  CREDIT_NOTE: 'CRN'
};

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

function periodFor(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

async function nextFinancialNumber({ documentType, hospitalId, date = new Date(), session } = {}) {
  if (!PREFIXES[documentType]) throw new Error(`Unsupported financial document type: ${documentType}`);
  const period = periodFor(date);
  const options = { new: true, upsert: true, setDefaultsOnInsert: true };
  if (session) options.session = session;

  const sequence = await FinancialSequence.findOneAndUpdate(
    { hospitalId: hospitalId || null, documentType, period },
    { $inc: { value: 1 } },
    options
  );

  return `${PREFIXES[documentType]}-${period}-${String(sequence.value).padStart(6, '0')}`;
}

module.exports = { money, periodFor, nextFinancialNumber };
