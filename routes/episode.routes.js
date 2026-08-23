// backend/routes/episode.routes.js
const express = require('express');
const router = express.Router();
const episodeController = require('../controllers/episode.controller');
const { requirePatientAccess } = require('../middlewares/patientAccess');

// ========== SPECIFIC ROUTES FIRST ==========
router.get('/suggest', episodeController.suggestEpisode);
router.get('/patient/:patientId', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), episodeController.getEpisodesByPatient);
router.get('/patient/:patientId/diagnosis/:diagnosis', requirePatientAccess({ patientParam: 'patientId', purpose: 'TREATMENT', scope: 'clinical_read' }), episodeController.getActiveEpisodeByDiagnosis);

// ========== PARAMETERIZED ROUTES ==========
router.get('/:episodeId/timeline', episodeController.getEpisodeTimeline);
router.get('/:episodeId', episodeController.getEpisodeById);

// ========== CREATE/UPDATE ==========
router.post('/', episodeController.createEpisode);
router.put('/:episodeId', episodeController.updateEpisode);

// ========== LINKING ==========
router.post('/link-appointment', episodeController.linkAppointmentToEpisode);

// ========== CLOSE/REOPEN ==========
router.post('/:episodeId/close', episodeController.closeEpisode);
router.post('/:episodeId/reopen', episodeController.reopenEpisode);

module.exports = router;