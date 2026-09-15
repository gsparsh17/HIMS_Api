const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');
const controller = require('../controllers/procedureRequest.controller');
const { protect, authorize, requireAnyModuleAccess, requireActionPermission } = require('../middlewares/auth');

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

// Generic clinical procedures are visible from OPD/IPD as well as OT, but
// administrative OPD/IPD "manage" permission must not implicitly grant clinical
// authority to approve/start/complete procedures or enter findings.
//
// Clinical mutation is allowed to Doctor/Nurse roles, or to any explicitly
// Operation-Theatre-authorised user. This keeps bedside procedures usable
// without turning registrar/reception permissions into clinical write access.
const view = [requireAnyModuleAccess([
  { moduleKey: 'operation_theatre', minimumAccess: 'view' },
  { moduleKey: 'registration_opd', minimumAccess: 'view' },
  { moduleKey: 'ipd', minimumAccess: 'view' }
])];

const requireOtManage = requireAnyModuleAccess([
  { moduleKey: 'operation_theatre', minimumAccess: 'manage' }
]);
const requireCareManage = requireAnyModuleAccess([
  { moduleKey: 'registration_opd', minimumAccess: 'manage' },
  { moduleKey: 'ipd', minimumAccess: 'manage' },
  { moduleKey: 'operation_theatre', minimumAccess: 'manage' }
]);

const clinicalManage = [(req, res, next) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (['admin', 'mediqliq_super_admin'].includes(role)) return next();
  return requireCareManage(req, res, () => requireActionPermission('ipd_clinical_write')(req, res, next));
}];

// Creating a non-surgical ProcedureRequest from an IPD patient file is an IPD
// clinical-ordering action, not an OT-management action. This allows a registrar
// or other delegated staff member with IPD clinical-write authority to place the
// request without granting broad Operation Theatre control. Surgery masters are
// still rejected by the controller and must be created through OT.
const procedureOrderCreate = (req, res, next) => {
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
  { moduleKey: 'billing_finance', minimumAccess: 'manage' },
  { moduleKey: 'operation_theatre', minimumAccess: 'manage' }
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