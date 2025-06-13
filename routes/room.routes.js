const express = require('express');
const router = express.Router();
const controller = require('../controllers/room.controller');

router.post('/', controller.createRoom);
router.get('/', controller.getAllRooms);
router.put('/:id', controller.updateRoom);
router.delete('/:id', controller.deleteRoom);
router.get('/:id', controller.getRoomById);

module.exports = router;
