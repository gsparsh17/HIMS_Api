'use strict';

// Financial/adjustment documents that can exist in the Invoice collection but
// must never be added as positive hospital revenue. Credit Note is active and
// its effect is represented on the originating invoice through
// credit_note_total. The advance/payment types are retained for legacy safety.
const NON_REVENUE_INVOICE_TYPES = Object.freeze([
  'IPD Payment',
  'IPD Advance Credit',
  'Pharmacy Advance Credit',
  'Credit Note'
]);

module.exports = {
  NON_REVENUE_INVOICE_TYPES
};
