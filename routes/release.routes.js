'use strict';

const express = require('express');
const c = require('../controllers/release.controller');

const router = express.Router();

// Release version management
router.post('/', c.create);
router.get('/', c.list);

module.exports = router;