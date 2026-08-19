'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithOperationTime } = require('../utils/operationTimeContext');
const IPDNursingAdmissionAssessment = require('../models/IPDNursingAdmissionAssessment');
const PharmacyReturn = require('../models/PharmacyReturn');
const PatientAdvanceLedger = require('../models/PatientAdvanceLedger');
const PharmacyLedgerSettlement = require('../models/PharmacyLedgerSettlement');
const DocumentSignature = require('../models/DocumentSignature');
const PatientDietOrder = require('../models/PatientDietOrder');
const Invoice = require('../models/Invoice');
const Sale = require('../models/Sale');
const PurchaseOrder = require('../models/PurchaseOrder');
const IssuedMedicine = require('../models/IssuedMedicine');
const EmergencyMedicationChecklist = require('../models/EmergencyMedicationChecklist');

const effectiveAt = new Date('2026-07-15T05:00:00.000Z');
const context = { effectiveAt, actualRequestAt: new Date('2026-08-19T10:28:00.000Z'), overridden: true, source: 'DATE_SETTER', timeZone: 'Asia/Kolkata' };
const iso = (value) => new Date(value).toISOString();

test('v3 business timestamp defaults follow effective operation time', async () => {
  await runWithOperationTime(context, async () => {
    assert.equal(iso(new IPDNursingAdmissionAssessment({ admissionId: '64b000000000000000000001', patientId: '64b000000000000000000002' }).assessmentAt), iso(effectiveAt));
    assert.equal(iso(new PharmacyReturn({ originalSaleId: '64b000000000000000000003', items: [] }).returnedAt), iso(effectiveAt));
    assert.equal(iso(new PatientAdvanceLedger({ patientId: '64b000000000000000000002', transactionType: 'ADVANCE_DEPOSIT', direction: 'CREDIT', amount: 1, balanceAfter: 1 }).postedAt), iso(effectiveAt));
    assert.equal(iso(new PharmacyLedgerSettlement({ settlement_type: 'FINAL_CLEARANCE', discount_scope: 'UNPAID_DUE', discount_type: 'FIXED', discount_value: 0, reason: 'test', created_by: '64b000000000000000000004' }).settledAt), iso(effectiveAt));
    assert.equal(iso(new DocumentSignature({ hospitalId: '64b000000000000000000005', documentType: 'test', sourceModel: 'IPDRound', sourceId: '64b000000000000000000006', signatoryRole: 'doctor', signedBy: '64b000000000000000000004', signatureHash: 'a'.repeat(64), sourceHash: 'b'.repeat(64) }).signedAt), iso(effectiveAt));
    assert.equal(iso(new PatientDietOrder({ hospitalId: '64b000000000000000000005', patientId: '64b000000000000000000002', dietType: 'Regular' }).startsAt), iso(effectiveAt));
    const invoice = new Invoice({ hospital_id: '64b000000000000000000005', patient_id: '64b000000000000000000002', invoice_number: 'TEST-V3', invoice_type: 'OPD', items: [], subtotal: 0, total_amount: 0, balance_due: 0 });
    assert.equal(iso(invoice.issue_date), iso(effectiveAt));
    assert.equal(iso(new Sale({ customer_type: 'Walk-in', items: [], total_amount: 0 }).sale_date), iso(effectiveAt));
    assert.equal(iso(new Sale({ customer_type: 'Walk-in', items: [], total_amount: 0, payments: [{ method: 'Cash', amount: 1 }] }).payments[0].date), iso(effectiveAt));
    assert.equal(iso(new PurchaseOrder({ supplier_id: '64b000000000000000000007', items: [], subtotal: 0, total_amount: 0 }).order_date), iso(effectiveAt));
    assert.equal(iso(new IssuedMedicine({ medicine_id: '64b000000000000000000008', quantity_issued: 1 }).issued_at), iso(effectiveAt));
    assert.equal(iso(new EmergencyMedicationChecklist({ hospitalId: '64b000000000000000000005', location: 'ER', items: [] }).checklistDate), iso(effectiveAt));
  });
});
