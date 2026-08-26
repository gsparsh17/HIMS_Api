const express = require('express');
const router = express.Router();
const controller = require('../controllers/room.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.get('/', controller.getAllRooms);
router.get('/:id', controller.getRoomById);
router.post('/', controller.createRoom);
router.put('/:id', controller.updateRoom);
router.patch('/:id', controller.patchRoomStatus);
router.patch('/:id/status', controller.patchRoomStatus);
router.delete('/:id', controller.deleteRoom);

module.exports = router;
