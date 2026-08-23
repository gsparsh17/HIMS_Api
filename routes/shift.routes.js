const express = require('express');
const router = express.Router();
const controller = require('../controllers/shift.controller');
const { authorize } = require('../middlewares/auth');

// ========== SHIFT HANDOVER ROUTES (must come before /:id) ==========
router.get('/handover/available-nurses/:outgoingNurseId', authorize('admin', 'nurse', 'hr_manager'), controller.getAvailableNursesForHandover);
router.get('/handover/patient-data', authorize('admin', 'nurse', 'hr_manager'), controller.getHandoverPatientData);
router.post('/handover', authorize('admin', 'nurse', 'hr_manager'), controller.createHandover);
router.get('/handover/history/:nurseId', authorize('admin', 'nurse', 'hr_manager'), controller.getHandoverHistory);
router.get('/handover/pending/:nurseId', authorize('admin', 'nurse', 'hr_manager'), controller.getPendingHandovers);
router.get('/handover/current/:nurseId', authorize('admin', 'nurse', 'hr_manager'), controller.getCurrentHandovers);
router.patch('/handover/:id/acknowledge', authorize('admin', 'nurse', 'hr_manager'), controller.acknowledgeHandover);

// Basic Shift CRUD
router.post('/', authorize('admin', 'hr_manager'), controller.createShift);
router.get('/', authorize('admin', 'nurse', 'hr_manager', 'staff'), controller.getAllShifts);
router.put('/:id', authorize('admin', 'hr_manager'), controller.updateShift);
router.delete('/:id', authorize('admin', 'hr_manager'), controller.deleteShift);
router.get('/:id', authorize('admin', 'nurse', 'hr_manager', 'staff'), controller.getShiftById);

module.exports = router;
