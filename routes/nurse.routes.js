const express = require('express');
const router = express.Router();
const nurseController = require('../controllers/nurse.controller');

// Create
router.post('/', nurseController.createNurse);

// Read
router.get('/', nurseController.getAllNurses);
router.get('/:id', nurseController.getNurseById);

// Update
router.put('/:id', nurseController.updateNurse);

// Delete
router.delete('/:id', nurseController.deleteNurse);

module.exports = router;
