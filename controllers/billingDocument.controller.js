'use strict';

const PrintTemplate = require('../models/PrintTemplate');
const Invoice = require('../models/Invoice');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');

exports.createTemplate = async (req, res) => {
  try {
    required(req.body, ['templateId', 'version', 'rendererId', 'title']);

    const row = await PrintTemplate.create({
      hospitalId: hospitalId(req),
      templateId: req.body.templateId,
      documentType: 'invoice',
      version: Number(req.body.version),
      rendererId: req.body.rendererId,
      title: req.body.title,
      pageCount: req.body.pageCount || 1,
      pageRules: req.body.pageRules || {},
      signatureRoles: req.body.signatureRoles || [],
      signatureAnchors: req.body.signatureAnchors || {},
      branding: req.body.branding || {},
      isActive: req.body.isActive !== false
    });

    return res.status(201).json({ success: true, data: row });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.listTemplates = async (req, res) => {
  const data = await PrintTemplate
    .find({
      hospitalId: hospitalId(req),
      documentType: 'invoice',
      isActive: true
    })
    .sort({ version: -1 })
    .lean();

  return res.json({ success: true, data });
};

exports.duplicatePrint = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.invoiceId,
      $or: [
        { hospital_id: hospitalId(req) },
        { hospitalId: hospitalId(req) }
      ]
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const prior = (invoice.printHistory || [])
      .filter(x => Number(x.duplicateNumber) > 0);

    if (prior.length >= 2) {
      return res.status(409).json({
        error: 'Duplicate bill print limit reached',
        limit: 2
      });
    }

    let template = null;

    if (req.body.templateId) {
      template = await PrintTemplate.findOne({
        _id: req.body.templateId,
        hospitalId: hospitalId(req),
        documentType: 'invoice',
        isActive: true
      });
    } else {
      template = await PrintTemplate
        .findOne({
          hospitalId: hospitalId(req),
          documentType: 'invoice',
          isActive: true
        })
        .sort({ version: -1 });
    }

    if (!template) {
      return res.status(404).json({
        error: 'Active billing print template not found'
      });
    }

    const duplicateNumber = prior.length + 1;
    const watermark = `DUPLICATE COPY ${duplicateNumber} OF 2`;

    invoice.printHistory = invoice.printHistory || [];
    invoice.printHistory.push({
      printedAt: new Date(),
      printedBy: req.user._id,
      duplicateNumber,
      watermark,
      templateId: template._id
    });

    await invoice.save({ validateBeforeSave: false });

    return res.json({
      success: true,
      data: {
        invoiceId: invoice._id,
        invoiceNumber: invoice.invoice_number || invoice.invoiceNumber,
        duplicateNumber,
        watermark,
        template: {
          _id: template._id,
          title: template.title,
          rendererId: template.rendererId,
          version: template.version
        },
        printData: invoice.toObject()
      }
    });
  } catch (e) {
    return sendError(res, e);
  }
};