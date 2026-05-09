const express = require('express');
const router = express.Router();
const controller = require('../controllers/shift.controller');

// ========== SHIFT HANDOVER ROUTES (must come before /:id) ==========
router.get('/handover/available-nurses/:outgoingNurseId', controller.getAvailableNursesForHandover);
router.get('/handover/patient-data', controller.getHandoverPatientData);
router.post('/handover', controller.createHandover);
router.get('/handover/history/:nurseId', controller.getHandoverHistory);
router.get('/handover/pending/:nurseId', controller.getPendingHandovers);
router.get('/handover/current/:nurseId', controller.getCurrentHandovers);
router.patch('/handover/:id/acknowledge', controller.acknowledgeHandover);

// Basic Shift CRUD
router.post('/', controller.createShift);
router.get('/', controller.getAllShifts);
router.put('/:id', controller.updateShift);
router.delete('/:id', controller.deleteShift);
router.get('/:id', controller.getShiftById);

module.exports = router;
