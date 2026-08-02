const BILLING_INTENTS = Object.freeze([
  'DEFER_TO_ENCOUNTER', 'BILL_NOW', 'ADD_TO_OPD_CART',
  'PACKAGE_INCLUDED', 'NO_CHARGE', 'EXTERNAL_REFERRAL'
]);
const BILLING_STATES = Object.freeze([
  'NOT_APPLICABLE', 'PENDING_CHARGE', 'CHARGE_POSTED', 'PARTIALLY_INVOICED',
  'INVOICED', 'CREDITED', 'REFUNDED', 'VOIDED'
]);

function sourceBillingFields(mongoose) {
  return {
    billingIntent: { type: String, enum: BILLING_INTENTS, default: 'DEFER_TO_ENCOUNTER', index: true },
    billingState: { type: String, enum: BILLING_STATES, default: 'PENDING_CHARGE', index: true },
    chargeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'IPDCharge' }],
    billIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Bill' }],
    invoiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
    pricingSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    billingHistory: [{
      from: String, to: String, action: String,
      documentId: mongoose.Schema.Types.ObjectId,
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reason: String
    }]
  };
}

module.exports = { BILLING_INTENTS, BILLING_STATES, sourceBillingFields };
