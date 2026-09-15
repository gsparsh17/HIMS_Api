const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { tempDir } = require('../config/upload.config');
const controller = require('../controllers/procedureRequest.controller');
const { protect, authorize, requireAnyModuleAccess } = require('../middlewares/auth');

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

// Generic clinical procedures are used by OPD/IPD as well as OT. Requiring the
// Operation Theatre module for every IV infusion/dressing/nebulization made
// non-OT clinical requests inaccessible to otherwise-authorised care teams.
const view = [requireAnyModuleAccess([
  { moduleKey: 'operation_theatre', minimumAccess: 'view' },
  { moduleKey: 'registration_opd', minimumAccess: 'view' },
  { moduleKey: 'ipd', minimumAccess: 'view' }
])];
const manage = [requireAnyModuleAccess([
  { moduleKey: 'operation_theatre', minimumAccess: 'manage' },
  { moduleKey: 'registration_opd', minimumAccess: 'manage' },
  { moduleKey: 'ipd', minimumAccess: 'manage' }
])];

// ============== PROCEDURE REQUEST ROUTES ==============
router.get('/categories', ...view, controller.getProcedureCategories);
router.post('/requests', ...manage, controller.createProcedureRequest);
router.get('/requests', ...view, controller.getProcedureRequests);
router.get('/requests/:id', ...view, controller.getProcedureRequestById);
router.patch('/requests/:id/status', ...manage, controller.updateRequestStatus);
router.post('/requests/:id/findings', ...manage, controller.addProcedureFindings);
router.post('/requests/:id/upload', ...manage, upload.single('file'), controller.uploadAttachment);
router.patch('/requests/:id/billed', ...manage, controller.markAsBilled);

// ============== ADMISSION-BASED QUERIES ==============
router.get('/admission/:admissionId/requests', ...view, controller.getRequestsByAdmission);
router.get('/admission/:admissionId/pending', ...view, controller.getPendingIPDRequests);
router.get('/patient/:patientId/requests', ...view, controller.getRequestsByPatient);
router.get('/dashboard/stats', ...view, controller.getDashboardStats);

module.exports = router;