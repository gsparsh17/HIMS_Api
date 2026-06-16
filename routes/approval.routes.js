const express = require('express');
const router = express.Router();
const approvalController = require('../controllers/approval.controller');
const { protect } = require('../middlewares/auth');

router.use(protect);

router.post('/', approvalController.createRequest);
router.get('/', approvalController.getRequests);
router.patch('/:id/status', approvalController.updateRequestStatus);
router.delete('/:id', approvalController.deleteRequest);

module.exports = router;
