const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');
const controller = require('../controllers/procedureRequest.controller');
const { protect, authorize, requireAnyModuleAccess, requireActionPermission, checkModuleAccess } = require('../middlewares/auth');

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, JPG, PNG are allowed.'));
    }
  }
});

router.use(
  protect,
  authorize('admin', 'mediqliq_super_admin', 'doctor', 'nurse', 'staff', 'registrar', 'receptionist', 'ot_staff', 'radiology_staff')
);

// Generic clinical procedures have their own delegable permission. A user with
// Procedures Manage can operate the request lifecycle end-to-end regardless of
// whether they work from Staff/Registrar or a dedicated clinical workspace.
const view = [requireAnyModuleAccess([
  { moduleKey: 'procedures', minimumAccess: 'view' }
])];

const clinicalManage = [requireAnyModuleAccess([
  { moduleKey: 'procedures', minimumAccess: 'manage' }
])];

// Creating a non-surgical ProcedureRequest from an IPD patient file is an IPD
// clinical-ordering action, not an OT-management action. This allows a registrar
// or other delegated staff member with IPD clinical-write authority to place the
// request without granting broad Operation Theatre control. Surgery masters are
// still rejected by the controller and must be created through OT.
const procedureOrderCreate = (req, res, next) => {
  // Procedures Manage is the end-to-end operational authority. Keep the older
  // encounter-ordering paths as a compatibility fallback for clinicians who
  // create the order from OPD/IPD without being procedure-workspace managers.
  if (checkModuleAccess(req.user, 'procedures', 'manage')) return next();

  const sourceType = String(req.body?.sourceType || 'IPD').trim().toUpperCase();
  if (sourceType === 'IPD') {
    return requireAnyModuleAccess([
      { moduleKey: 'ipd', minimumAccess: 'manage' }
    ])(req, res, () => requireActionPermission('ipd_clinical_write')(req, res, next));
  }

  return requireAnyModuleAccess([
    { moduleKey: 'registration_opd', minimumAccess: 'manage' }
  ])(req, res, next);
};

const billingManage = [requireAnyModuleAccess([
  { moduleKey: 'billing_finance', minimumAccess: 'manage' }
])];

// ============== PROCEDURE REQUEST ROUTES ==============
router.get('/categories', ...view, controller.getProcedureCategories);
router.post('/requests', procedureOrderCreate, controller.createProcedureRequest);
router.get('/requests', ...view, controller.getProcedureRequests);
router.get('/requests/:id', ...view, controller.getProcedureRequestById);
router.patch('/requests/:id/status', ...clinicalManage, controller.updateRequestStatus);
router.post('/requests/:id/findings', ...clinicalManage, controller.addProcedureFindings);
router.post('/requests/:id/upload', ...clinicalManage, upload.single('file'), controller.uploadAttachment);
router.patch('/requests/:id/billed', ...billingManage, controller.markAsBilled);

// ============== ADMISSION-BASED QUERIES ==============
router.get('/admission/:admissionId/requests', ...view, controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', ...view, controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', ...view, controller.getRequestsByPatient);
router.get('/dashboard/stats', ...view, controller.getDashboardStats);

module.exports = router;