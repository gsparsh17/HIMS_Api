const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const otController = require('../controllers/ot.controller');

// Create uploads directory if not exists
const fs = require('fs');
const OTStaff = require('../models/OTStaff');
const uploadDir = 'uploads/ot/';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `OT-${Date.now()}${path.extname(file.originalname)}`)
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, JPEG, PNG are allowed.'));
    }
  }
});

// ============== OT REQUEST ROUTES ==============
router.post('/requests', otController.createOTRequest);
router.get('/requests', otController.getOTRequests);
router.get('/requests/:id', otController.getOTRequestById);
router.patch('/requests/:id/status', otController.updateOTRequestStatus);
router.put('/requests/:id/assign', otController.assignOTRoom);
router.patch('/requests/:id/start', otController.startSurgery);
router.post('/requests/:id/complete', otController.completeSurgery);
router.patch('/requests/:id/cancel', otController.cancelOTRequest);
router.post('/requests/:id/upload-report', upload.single('report'), otController.uploadSurgeryReport);
router.get('/requests/:id/download-report', otController.downloadSurgeryReport);
router.post('/requests/:id/transfer-patient', otController.transferPatientPostOp);
router.patch('/requests/:id/billed', otController.markAsBilled);

// ============== OT STAFF ROUTES ==============
router.post('/staff', otController.createOTStaff);
router.get('/staff', otController.getOTStaff);
router.get('/staff/available', otController.getAvailableOTStaff);
router.get('/staff/:id', async (req, res) => {
  try {
    const otStaff = await OTStaff.findById(req.params.id).populate('userId', 'name email');
    if (!otStaff) {
      return res.status(404).json({ error: 'OT Staff not found' });
    }
    res.json({ success: true, data: otStaff });
  } catch (error) {
    console.error('Error fetching OT staff:', error);
    res.status(500).json({ error: error.message });
  }
});
router.put('/staff/:id', otController.updateOTStaff);
router.patch('/staff/:id/toggle-status', otController.toggleOTStaffStatus);
router.delete('/staff/:id', otController.deleteOTStaff);

// ============== OT SCHEDULE ROUTES ==============
router.get('/schedule/:date', otController.getDailySchedule);

// ============== SPECIALIZED QUERIES ==============
router.get('/admission/:admissionId/requests', otController.getRequestsByAdmission);
router.get('/doctor/:doctorId/requests', otController.getRequestsByDoctor);
router.get('/dashboard/stats', otController.getDashboardStats);

// ============== REPORT ROUTES ==============
router.get('/reports/monthly', otController.getMonthlyReports);
router.get('/reports/procedures', otController.getProcedureStats);
router.get('/reports/surgeons', otController.getSurgeonStats);
router.get('/reports/export/:type', otController.exportOTReports);

// ============== OT ROOM UTILITIES (using existing Room model) ==============
router.get('/ot-rooms', otController.getOTRooms);
router.get('/ot-rooms/available', otController.getAvailableOTRooms);

module.exports = router;