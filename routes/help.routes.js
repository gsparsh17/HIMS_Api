'use strict';

const express = require('express');
const c = require('../controllers/help.controller');

const router = express.Router();

// Help article management
router.post('/', c.create);
router.get('/', c.list);
router.get('/:slug', c.get);

module.exports = router;