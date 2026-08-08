const mongoose = require('mongoose');
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
  const sequenceFilter = { hospitalId: hospitalId || null, documentType, period };

  // Older/imported databases can already contain invoices while the atomic
  // FinancialSequence document is absent or behind. Seed the sequence from the
  // highest real invoice number before incrementing so a legitimate new issue
  // never collides with an existing unique invoice_number.
  if (documentType === 'INVOICE' && mongoose.models.Invoice) {
    const prefix = `${PREFIXES[documentType]}-${period}-`;
    const invoiceFilter = {
      invoice_number: { $regex: `^${prefix}\\d+$` }
    };
    if (hospitalId) {
      invoiceFilter.$or = [{ hospital_id: hospitalId }, { hospitalId }];
    }
    const query = mongoose.models.Invoice
      .findOne(invoiceFilter)
      .sort({ invoice_number: -1 })
      .select('invoice_number');
    if (session) query.session(session);
    const latest = await query.lean();
    const seed = Number(String(latest?.invoice_number || '').slice(prefix.length)) || 0;
    if (seed > 0) {
      const seedOptions = { upsert: true, setDefaultsOnInsert: true };
      if (session) seedOptions.session = session;
      await FinancialSequence.updateOne(
        sequenceFilter,
        { $max: { value: seed }, $setOnInsert: sequenceFilter },
        seedOptions
      );
    }
  }

  const options = { new: true, upsert: true, setDefaultsOnInsert: true };
  if (session) options.session = session;
  const sequence = await FinancialSequence.findOneAndUpdate(
    sequenceFilter,
    { $inc: { value: 1 } },
    options
  );

  return `${PREFIXES[documentType]}-${period}-${String(sequence.value).padStart(6, '0')}`;
}

module.exports = { money, periodFor, nextFinancialNumber };
