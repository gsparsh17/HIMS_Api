const express = require('express');
const router = express.Router();
const wardController = require('../controllers/ward.controller');

router.post('/', wardController.createWard);
router.get('/', wardController.getAllWards);
router.get('/:id', wardController.getWardById);
router.put('/:id', wardController.updateWard);
router.delete('/:id', wardController.deleteWard);

module.exports = router;