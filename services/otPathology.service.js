const LabTest = require('../models/LabTest');
const LabRequest = require('../models/LabRequest');
const { postSourceCharge } = require('./chargePosting.service');

async function ensurePathologyOrder({ otCase, specimen, labTestId, user }) {
  if (!labTestId) return { specimen, labRequest: null, financialWarning: null };
  let existing = await LabRequest.findOne({ hospitalId: otCase.hospitalId, otSpecimenId: specimen._id });
  if (existing) {
    specimen.pathologyOrderId = existing._id;
    specimen.pathologyLabTestId = existing.labTestId;
    if (specimen.pathologyChargeStatus === 'Not Requested') specimen.pathologyChargeStatus = 'Pending';
    await specimen.save();
    return { specimen, labRequest: existing, financialWarning: null, reused: true };
  }

  const labTest = await LabTest.findOne({ _id: labTestId, hospitalId: otCase.hospitalId, is_active: { $ne: false } });
  if (!labTest) throw Object.assign(new Error('Selected pathology/laboratory test was not found'), { statusCode: 404 });
  const doctorId = otCase.primarySurgeonId || otCase.doctorId;
  if (!doctorId) throw Object.assign(new Error('OT case does not have a requesting doctor for pathology'), { statusCode: 409 });

  const labRequest = await LabRequest.create({
    hospitalId: otCase.hospitalId,
    sourceType: 'IPD',
    admissionId: otCase.admissionId,
    patientId: otCase.patientId,
    doctorId,
    labTestId: labTest._id,
    testCode: labTest.code,
    testName: labTest.name,
    category: labTest.category,
    clinical_indication: `Surgical specimen from OT case ${otCase.requestNumber}: ${specimen.label}${specimen.site ? ` (${specimen.site})` : ''}`,
    clinical_history: otCase.clinical_history || '',
    priority: otCase.urgency === 'Emergency' ? 'Stat' : otCase.urgency === 'Urgent' ? 'Urgent' : 'Routine',
    requestGroupKey: `OT:${otCase._id}:SPECIMEN:${specimen._id}`,
    patient_notes: `OT specimen ${specimen.specimenNumber}; container ${specimen.container || 'not recorded'}; preservative ${specimen.preservative || 'not recorded'}`,
    cost: labTest.base_price,
    otCaseId: otCase._id,
    otSpecimenId: specimen._id,
    createdBy: user._id
  });
  try { await labTest.incrementUsage?.(); } catch (_) { /* non-blocking catalog statistic */ }

  specimen.pathologyOrderId = labRequest._id;
  specimen.pathologyLabTestId = labTest._id;
  specimen.pathologyChargeStatus = 'Pending';
  await specimen.save();

  let financialWarning = null;
  try {
    await postSourceCharge({
      sourceModule: 'LabRequest',
      sourceId: labRequest._id,
      idempotencyKey: `LabRequest:${labRequest._id}:charge`,
      user
    });
    specimen.pathologyChargeStatus = 'Posted';
    await specimen.save();
  } catch (error) {
    specimen.pathologyChargeStatus = 'Failed';
    await specimen.save();
    financialWarning = { code: error.code || 'PATHOLOGY_FINANCE_PENDING', message: error.message };
  }

  return { specimen, labRequest, financialWarning, reused: false };
}

module.exports = { ensurePathologyOrder };
