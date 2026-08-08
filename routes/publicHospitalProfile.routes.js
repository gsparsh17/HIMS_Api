'use strict';

const express = require('express');
const Hospital = require('../models/Hospital');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const query = {};

    if (req.query.hospitalId) {
      query._id = req.query.hospitalId;
    }

    if (req.query.tenantCode) {
      query.tenantCode = req.query.tenantCode;
    }

    const hospital = await Hospital
      .findOne(query)
      .select('hospitalName name logo tenantCode certifications')
      .lean();

    if (!hospital) {
      return res.status(404).json({
        error: 'Hospital not found'
      });
    }

    return res.json({
      success: true,
      data: {
        _id: hospital._id,
        name: hospital.hospitalName || hospital.name,
        logo: hospital.logo,
        tenantCode: hospital.tenantCode,
        certifications: (hospital.certifications || [])
          .filter(x => x.public !== false)
      }
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message
    });
  }
});

module.exports = router;