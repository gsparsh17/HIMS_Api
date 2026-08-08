'use strict';

const express = require('express');
const c = require('../controllers/patientExperience.controller');

const router = express.Router();

// Announcements
router.post('/announcements', c.createAnnouncement);
router.get('/announcements', c.announcements);

// Surveys
router.post('/surveys', c.createSurvey);
router.get('/surveys', c.listSurveys);
router.post('/surveys/:id/invitations', c.sendSurvey);

// Responses
router.post('/responses', c.submit);

// Complaints
router.put('/complaints/:id/resolve', c.resolveComplaint);

// Analytics
router.get('/analytics', c.analytics);

// Hospital profile
router.put('/hospital-certifications', c.updateCertifications);
router.get('/hospital-profile', c.profile);

module.exports = router;