const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const legacy = require('../controllers/ot.controller');
const cases = require('../controllers/otCase.controller');
const clinicalForms = require('../controllers/otClinicalForm.controller');
const OTStaff = require('../models/OTStaff');
const OTRequest = require('../models/OTRequest');
const { protect, authorize } = require('../middlewares/auth');
const { requireHospitalId } = require('../services/tenantScope.service');

const router = express.Router();
const uploadDir = 'uploads/ot/';
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

router.use(protect, authorize('admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'ot_staff', 'store_manager', 'inventory_manager', 'accountant'));

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
router.get('/form-templates', clinicalForms.listTemplates);
router.get('/cases/:id/forms', clinicalForms.listCaseForms);
router.get('/cases/:id/forms/:templateId/preview.pdf', clinicalForms.previewCaseFormPdf);
router.post('/cases/:id/forms/:templateId/finalize.pdf', clinicalForms.finalizeCaseFormPdf);
router.get('/cases/:id/forms/:templateId/rendered/:renderedId', clinicalForms.streamRenderedCaseForm);
router.get('/cases/:id/forms/:templateId', clinicalForms.getCaseForm);
router.put('/cases/:id/forms/:templateId', clinicalForms.saveCaseForm);
router.delete('/cases/:id/forms/:templateId', clinicalForms.resetCaseForm);

// Full OT case workspace.
router.post('/cases', cases.createCase);
router.get('/cases', cases.listCases);
router.get('/cases/:id', cases.getCase);
router.get('/cases/:id/workspace', cases.getWorkspace);
router.put('/cases/:id/schedule', cases.scheduleCase);
router.post('/cases/:id/transition', cases.transitionCase);
router.get('/cases/:id/readiness', cases.getReadiness);
router.put('/cases/:id/readiness', cases.updateReadiness);
router.get('/cases/:id/safety-checklist', cases.getSafety);
router.put('/cases/:id/safety-checklist', cases.updateSafety);
router.get('/cases/:id/pac', cases.getPac);
router.put('/cases/:id/pac', cases.savePac);
router.get('/cases/:id/anesthesia-record', cases.getAnesthesia);
router.put('/cases/:id/anesthesia-record', cases.saveAnesthesia);
router.get('/cases/:id/operative-note', cases.getOperative);
router.put('/cases/:id/operative-note', cases.saveOperative);
router.get('/cases/:id/recovery', cases.getRecovery);
router.put('/cases/:id/recovery', cases.saveRecovery);
router.get('/cases/:id/inventory', cases.getInventory);
router.put('/cases/:id/inventory', cases.saveInventory);
router.post('/cases/:id/specimens', cases.createSpecimen);
router.get('/cases/:id/packet.pdf', clinicalForms.casePacketPdf);
router.get('/cases/:id/packet', cases.getCasePacket);

// Backward-compatible request URLs now use the tenant-scoped case workflow.
router.post('/requests', cases.createCase);
router.get('/requests', cases.listCases);
router.get('/requests/:id', cases.getCase);
router.patch('/requests/:id/status', cases.legacyStatusTransition);
router.put('/requests/:id/assign', cases.scheduleCase);
router.patch('/requests/:id/start', (req, _res, next) => { req.body.action = 'start'; next(); }, cases.transitionCase);
router.post('/requests/:id/complete', cases.completeSurgeryLegacy);
router.patch('/requests/:id/cancel', (req, _res, next) => { req.body.action = 'cancel'; next(); }, cases.transitionCase);

// Existing payment/report/billing adapters retained for compatibility.
router.post('/requests/:id/payment', ensureCaseTenant, legacy.processOTPayment);
router.post('/requests/:id/upload-report', ensureCaseTenant, upload.single('report'), legacy.uploadSurgeryReport);
router.get('/requests/:id/download-report', ensureCaseTenant, legacy.downloadSurgeryReport);
router.post('/requests/:id/transfer-patient', ensureCaseTenant, legacy.transferPatientPostOp);
router.patch('/requests/:id/billed', ensureCaseTenant, legacy.markAsBilled);

router.post('/staff', legacy.createOTStaff);
router.get('/staff', legacy.getOTStaff);
router.get('/staff/available', legacy.getAvailableOTStaff);
router.get('/staff/:id', async (req, res, next) => {
  try {
    const data = await OTStaff.findOne({ _id: req.params.id, hospitalId: requireHospitalId(req) }).populate('userId', 'name email role');
    if (!data) return res.status(404).json({ error: 'OT staff not found' });
    res.json({ success: true, data });
  } catch (error) { next(error); }
});
router.put('/staff/:id', legacy.updateOTStaff);
router.patch('/staff/:id/toggle-status', legacy.toggleOTStaffStatus);
router.delete('/staff/:id', legacy.deleteOTStaff);

router.get('/schedule/:date', legacy.getDailySchedule);
router.get('/admission/:admissionId/requests', legacy.getRequestsByAdmission);
router.get('/doctor/:doctorId/requests', legacy.getRequestsByDoctor);
router.get('/dashboard/stats', legacy.getDashboardStats);
router.get('/reports/monthly', legacy.getMonthlyReports);
router.get('/reports/procedures', legacy.getProcedureStats);
router.get('/reports/surgeons', legacy.getSurgeonStats);
router.get('/reports/export/:type', legacy.exportOTReports);
router.get('/ot-rooms', legacy.getOTRooms);
router.get('/ot-rooms/available', legacy.getAvailableOTRooms);

module.exports = router;
