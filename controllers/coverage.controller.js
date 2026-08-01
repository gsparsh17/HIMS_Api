const mongoose = require('mongoose');
const AdmissionCoverage = require('../models/AdmissionCoverage');
const { requireHospitalId } = require('../services/tenantScope.service');
const coverageService = require('../services/coverage.service');

function fail(res, e) {
  res.status(e.statusCode || 400).json({ success: false, error: e.message });
}

async function transaction(work) {
  const session = await mongoose.startSession();

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

exports.create = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await transaction((session) =>
      coverageService.createCoverage({
        req,
        hospitalId,
        admissionId: req.params.id,
        payload: req.body,
        session
      })
    );

    res.status(201).json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.get = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await AdmissionCoverage
      .findOne({
        hospitalId,
        admissionId: req.params.id,
        active: true
      })
      .populate('payerId')
      .populate('tpaId')
      .populate('rateCardId');

    if (!data) {
      // A valid self-pay admission normally has no AdmissionCoverage document.
      // Confirm the admission belongs to this hospital so an invalid/cross-tenant
      // identifier still returns 404, then represent "no active coverage" as a
      // successful empty result instead of a failed network request.
      await coverageService.tenantAdmission(hospitalId, req.params.id);

      return res.json({
        success: true,
        data: null,
        meta: {
          hasActiveCoverage: false,
          caseType: 'self_pay'
        }
      });
    }

    return res.json({
      success: true,
      data,
      meta: {
        hasActiveCoverage: true,
        caseType: 'sponsored'
      }
    });
  } catch (e) {
    fail(res, e);
  }
};

exports.verify = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await transaction((session) =>
      coverageService.updateEligibility({
        req,
        hospitalId,
        admissionId: req.params.id,
        payload: req.body,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.preauth = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const data = await transaction((session) =>
      coverageService.updatePreAuth({
        req,
        hospitalId,
        admissionId: req.params.id,
        payload: req.body,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};

exports.updatePreauthById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const coverage = await AdmissionCoverage.findOne({
      _id: req.params.id,
      hospitalId,
      active: true
    });

    if (!coverage) {
      return res.status(404).json({
        success: false,
        error: 'Coverage not found'
      });
    }

    const data = await transaction((session) =>
      coverageService.updatePreAuth({
        req,
        hospitalId,
        admissionId: coverage.admissionId,
        payload: req.body,
        session
      })
    );

    res.json({ success: true, data });
  } catch (e) {
    fail(res, e);
  }
};