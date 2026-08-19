const express = require('express');
const controller = require('../controllers/setupAssistant.controller');
const { isStaff } = require('../middlewares/auth');

const router = express.Router();
// /api is already authenticated and MFA-gated in app.js. Re-running protect here
// would verify the JWT and query User a second time for every assistant request.
router.use(isStaff);
router.get('/status', controller.status);
router.put('/steps/:stepKey/skip', controller.skip);
router.delete('/skips', controller.clearSkips);
router.post('/ask', controller.ask);

module.exports = router;
