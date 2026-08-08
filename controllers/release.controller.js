'use strict';

const ReleaseVersion = require('../models/ReleaseVersion');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');

exports.create = async (req, res) => {
  try {
    required(req.body, ['version', 'releaseType', 'summary']);

    const row = await ReleaseVersion.create({
      hospitalId: hospitalId(req),
      version: req.body.version,
      releaseType: req.body.releaseType,
      commitReference: req.body.commitReference,
      issueReferences: req.body.issueReferences || [],
      summary: req.body.summary,
      documentationUrl: req.body.documentationUrl,
      releasedAt: req.body.releasedAt || new Date(),
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.list = async (req, res) => {
  const filter = {
    hospitalId: hospitalId(req)
  };

  if (req.query.releaseType) {
    filter.releaseType = req.query.releaseType;
  }

  const data = await ReleaseVersion
    .find(filter)
    .sort({ releasedAt: -1 })
    .lean();

  return res.json({
    success: true,
    data
  });
};