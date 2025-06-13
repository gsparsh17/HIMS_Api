const express = require('express');
const router = express.Router();
const controller = require('../controllers/shift.controller');

router.post('/', controller.createShift);
router.get('/', controller.getAllShifts);
router.put('/:id', controller.updateShift);
router.delete('/:id', controller.deleteShift);
router.get('/:id', controller.getShiftById);

module.exports = router;
