const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { tempDir } = require('../config/upload.config');
const legacy = require('../controllers/ot.controller');
const cases = require('../controllers/otCase.controller');
const clinicalForms = require('../controllers/otClinicalForm.controller');
const OTStaff = require('../models/OTStaff');
const OTRequest = require('../models/OTRequest');
const { protect, requireActionPermission } = require('../middlewares/auth');
const { requireHospitalId } = require('../services/tenantScope.service');
const insights = require('../controllers/otInsights.controller');
const { requireOtCapability, requireOtTransitionCapability, requireOtFormCapability, requireOtLegacyStatusCapability } = require('../services/otAccess.service');

const router = express.Router();
const uploadDir = path.join(tempDir, 'ot');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `OT-${Date.now()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only PDF, JPEG and PNG files are allowed'), allowed.includes(file.mimetype));
  }
});

// Authentication is global; OT authorization is capability-driven below.
router.use(protect);

async function ensureCaseTenant(req, res, next) {
  try {
    const exists = await OTRequest.exists({ _id: req.params.id, hospitalId: requireHospitalId(req) });
    if (!exists) return res.status(404).json({ error: 'OT case not found' });
    return next();
  } catch (error) {
    return next(error);
  }
}


// Complete surgery-form registry based on the hospital surgical patient file.
router.get('/form-templates', requireOtCapability('ot.case.view'), clinicalForms.listTemplates);
router.get('/dashboard', requireOtCapability('ot.case.view'), insights.dashboard);
router.get('/reports/overview', requireOtCapability('ot.case.view'), insights.reports);
router.get('/cases/:id/audit', requireOtCapability('ot.case.view'), insights.audit);
router.get('/cases/:id/forms', requireOtCapability('ot.case.view'), clinicalForms.listCaseForms);
router.get('/cases/:id/forms/:templateId/preview.pdf', requireOtCapability('ot.case.view'), clinicalForms.previewCaseFormPdf);
router.post('/cases/:id/forms/:templateId/finalize.pdf', requireOtFormCapability, clinicalForms.finalizeCaseFormPdf);
router.get('/cases/:id/forms/:templateId/rendered/:renderedId', requireOtCapability('ot.case.view'), clinicalForms.streamRenderedCaseForm);
router.get('/cases/:id/forms/:templateId', requireOtCapability('ot.case.view'), clinicalForms.getCaseForm);
router.put('/cases/:id/forms/:templateId', requireOtFormCapability, clinicalForms.saveCaseForm);
router.delete('/cases/:id/forms/:templateId', requireOtFormCapability, clinicalForms.resetCaseForm);

// Full OT case workspace.
router.post('/cases', requireOtCapability('ot.case.create'), cases.createCase);
router.get('/cases', requireOtCapability('ot.case.view'), cases.listCases);
router.get('/cases/:id', requireOtCapability('ot.case.view'), cases.getCase);
router.get('/cases/:id/workspace', requireOtCapability('ot.case.view'), cases.getWorkspace);
router.get('/cases/:id/financial', requireOtCapability('ot.finance.view'), cases.getFinancial);
router.get('/cases/:id/financial/reconciliation', requireOtCapability('ot.finance.view'), cases.getFinancialReconciliation);
router.post('/cases/:id/financial/refresh', requireOtCapability('ot.finance.view'), cases.getFinancial);
router.post('/cases/:id/schedule/check', requireOtCapability('ot.schedule.manage'), cases.previewSchedule);
router.put('/cases/:id/schedule', requireOtCapability('ot.schedule.manage'), cases.scheduleCase);
router.put('/cases/:id/emergency-override', requireOtCapability('ot.case.view'), requireActionPermission('ot_emergency_bypass'), cases.setEmergencyOverride);
router.post('/cases/:id/transition', requireOtTransitionCapability, cases.transitionCase);
router.get('/cases/:id/readiness', requireOtCapability('ot.case.view'), cases.getReadiness);
router.put('/cases/:id/readiness', requireOtCapability('ot.readiness.update'), cases.updateReadiness);
router.get('/cases/:id/safety-checklist', requireOtCapability('ot.case.view'), cases.getSafety);
router.put('/cases/:id/safety-checklist', requireOtCapability('ot.safety.update'), cases.updateSafety);
router.get('/cases/:id/pac', requireOtCapability('ot.case.view'), cases.getPac);
router.put('/cases/:id/pac', requireOtCapability('ot.pac.edit'), cases.savePac);
router.get('/cases/:id/anesthesia-record', requireOtCapability('ot.case.view'), cases.getAnesthesia);
router.put('/cases/:id/anesthesia-record', requireOtCapability('ot.anesthesia.edit'), cases.saveAnesthesia);
router.get('/cases/:id/operative-note', requireOtCapability('ot.case.view'), cases.getOperative);
router.put('/cases/:id/operative-note', requireOtCapability('ot.operation_note.edit'), cases.saveOperative);
router.get('/cases/:id/recovery', requireOtCapability('ot.case.view'), cases.getRecovery);
router.put('/cases/:id/recovery', requireOtCapability('ot.recovery.manage'), cases.saveRecovery);
router.get('/cases/:id/inventory', requireOtCapability('ot.case.view'), cases.getInventory);
router.get('/cases/:id/inventory/options', requireOtCapability('ot.inventory.manage'), cases.getInventoryOptions);
router.put('/cases/:id/inventory', requireOtCapability('ot.inventory.manage'), cases.saveInventory);
router.post('/cases/:id/specimens', requireOtCapability('ot.specimen.manage'), cases.createSpecimen);
router.patch('/cases/:id/specimens/:specimenId', requireOtCapability('ot.specimen.manage'), cases.updateSpecimen);
router.post('/cases/:id/additional-procedures', requireOtCapability('ot.operation_note.edit'), cases.addAdditionalProcedure);
router.get('/cases/:id/packet.pdf', requireOtCapability('ot.case.view'), clinicalForms.casePacketPdf);
router.get('/cases/:id/packet', requireOtCapability('ot.case.view'), cases.getCasePacket);

// Backward-compatible request URLs now use the tenant-scoped case workflow.
router.post('/requests', requireOtCapability('ot.case.create'), cases.createCase);
router.get('/requests', requireOtCapability('ot.case.view'), cases.listCases);
router.get('/requests/:id', requireOtCapability('ot.case.view'), cases.getCase);
router.patch('/requests/:id/status', requireOtLegacyStatusCapability, cases.legacyStatusTransition);
router.put('/requests/:id/assign', requireOtCapability('ot.schedule.manage'), cases.scheduleCase);
router.patch('/requests/:id/start', (req, _res, next) => { req.body.action = 'start'; next(); }, requireOtTransitionCapability, cases.transitionCase);
router.post('/requests/:id/complete', requireOtCapability('ot.operation_note.edit'), cases.completeSurgeryLegacy);
router.patch('/requests/:id/cancel', (req, _res, next) => { req.body.action = 'cancel'; next(); }, requireOtTransitionCapability, cases.transitionCase);

// Existing payment/report/billing adapters retained for compatibility.
router.post('/requests/:id/payment', ensureCaseTenant, requireOtCapability('ot.finance.manage'), legacy.processOTPayment);
router.post('/requests/:id/upload-report', ensureCaseTenant, requireOtCapability('ot.operation_note.edit'), upload.single('report'), legacy.uploadSurgeryReport);
router.get('/requests/:id/download-report', ensureCaseTenant, requireOtCapability('ot.case.view'), legacy.downloadSurgeryReport);
router.post('/requests/:id/transfer-patient', ensureCaseTenant, requireOtCapability('ot.recovery.manage'), legacy.transferPatientPostOp);
router.patch('/requests/:id/billed', ensureCaseTenant, requireOtCapability('ot.finance.manage'), legacy.markAsBilled);

router.post('/staff', requireOtCapability('ot.master.manage'), legacy.createOTStaff);
router.get('/staff', requireOtCapability('ot.case.view'), legacy.getOTStaff);
router.get('/staff/available', requireOtCapability('ot.schedule.manage'), legacy.getAvailableOTStaff);
router.get('/staff/:id', requireOtCapability('ot.case.view'), async (req, res, next) => {
  try {
    const data = await OTStaff.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req) }).populate('userId', 'name email role');
    if (!data) return res.status(404).json({ error: 'OT staff not found' });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});
router.put('/staff/:id', requireOtCapability('ot.master.manage'), legacy.updateOTStaff);
router.patch('/staff/:id/toggle-status', requireOtCapability('ot.master.manage'), legacy.toggleOTStaffStatus);
router.delete('/staff/:id', requireOtCapability('ot.master.manage'), legacy.deleteOTStaff);

router.get('/schedule/:date', requireOtCapability('ot.case.view'), legacy.getDailySchedule);
router.get('/admission/:admissionId/requests', requireOtCapability('ot.case.view'), (req, res, next) => { req.query.admissionId = req.params.admissionId; return cases.listCases(req, res, next); });
router.get('/doctor/:doctorId/requests', requireOtCapability('ot.case.view'), (req, res, next) => { req.query.doctorId = req.params.doctorId; return cases.listCases(req, res, next); });
router.get('/dashboard/stats', requireOtCapability('ot.case.view'), insights.dashboard);
router.get('/reports/monthly', requireOtCapability('ot.case.view'), legacy.getMonthlyReports);
router.get('/reports/procedures', requireOtCapability('ot.case.view'), legacy.getProcedureStats);
router.get('/reports/surgeons', requireOtCapability('ot.case.view'), legacy.getSurgeonStats);
router.get('/reports/export/:type', requireOtCapability('ot.case.view'), legacy.exportOTReports);
router.get('/ot-rooms', requireOtCapability('ot.case.view'), legacy.getOTRooms);
router.get('/ot-rooms/available', requireOtCapability('ot.schedule.manage'), legacy.getAvailableOTRooms);

module.exports = router;
