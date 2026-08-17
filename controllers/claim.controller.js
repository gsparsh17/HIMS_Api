const ExcelJS = require('exceljs');
const ClaimCase = require('../models/ClaimCase');
const SponsorLedgerEntry = require('../models/SponsorLedgerEntry');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const claimService = require('../services/claim.service');

function fail(res, error) {
  res.status(error.statusCode || 400).json({ success: false, error: error.message, readiness: error.readiness, details: error.details });
}

async function audit(req, claim, eventType, summary = {}) {
  return appendDomainEvent({
    req,
    eventType,
    entityType: 'ClaimCase',
    entityId: claim._id,
    hospitalId: claim.hospitalId,
    patientId: claim.patientId,
    encounterId: claim.admissionId || claim.appointmentId,
    revision: claim.revision,
    afterSummary: { claimNumber: claim.claimNumber, status: claim.status, ...summary }
  });
}

exports.create = async (req, res) => {
  try {
    const data = await claimService.createClaim({ hospitalId: requireHospitalId(req), body: req.body, user: req.user });
    await audit(req, data, 'billing.claim_created');
    res.status(201).json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.refresh = async (req, res) => {
  try {
    const data = await claimService.refreshClaim({ hospitalId: requireHospitalId(req), claimId: req.params.id, user: req.user });
    await audit(req, data, 'billing.claim_rebuilt', { lineCount: data.lines.length });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.list = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = claimService.claimFilter(hospitalId, req.query);
    if (req.query.search) filter.claimNumber = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const [data, total] = await Promise.all([
      ClaimCase.find(filter)
        .populate('payerId', 'code name type')
        .populate('patientId', 'first_name last_name patientId uhid')
        .populate('admissionId', 'admissionNumber admissionDate dischargeDate')
        .populate('appointmentId', 'token appointment_date')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      ClaimCase.countDocuments(filter)
    ]);
    res.json({ success: true, data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { fail(res, error); }
};

exports.get = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const data = await ClaimCase.findOne({ _id: req.params.id, hospitalId })
      .populate('payerId')
      .populate('coverageId')
      .populate('admissionId')
      .populate('appointmentId')
      .populate('patientId');
    if (!data) return res.status(404).json({ success: false, error: 'Claim not found' });
    const ledger = await SponsorLedgerEntry.find({ hospitalId, claimId: data._id }).sort({ occurredAt: 1 });
    return res.json({ success: true, data, ledger });
  } catch (error) { return fail(res, error); }
};

exports.updateDraft = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const claim = await ClaimCase.findOne({ _id: req.params.id, hospitalId });
    if (!claim) return res.status(404).json({ success: false, error: 'Claim not found' });
    if (!['draft', 'documents_pending', 'ready', 'query'].includes(claim.status)) {
      return res.status(409).json({ success: false, error: 'Submitted/settled claim cannot be edited directly' });
    }
    const allowed = ['type', 'documents', 'status', 'preAuth', 'schemeType'];
    for (const key of allowed) if (req.body[key] !== undefined) claim[key] = req.body[key];
    if (req.body.schemeData !== undefined) {
      claim.schemeData = { ...(claim.schemeData?.toObject?.() || claim.schemeData || {}), ...req.body.schemeData };
      claim.markModified('schemeData');
    }
    if (req.body.lines) {
      const patches = new Map(req.body.lines.map((row) => [String(row.lineId || row._id), row]));
      for (const line of claim.lines) {
        const patch = patches.get(String(line._id));
        if (!patch) continue;
        if (patch.submittedAmount !== undefined) {
          const submitted = claimService.money(patch.submittedAmount);
          if (submitted < 0 || submitted > Number(line.sponsorLiability || 0)) {
            return res.status(400).json({ success: false, error: `Invalid submitted amount for line ${line.lineNumber}` });
          }
          line.submittedAmount = submitted;
        }
      }
      const totals = claimService.summarizeLines(claim.lines);
      claim.amounts.claimSubmittedAmount = totals.claimSubmittedAmount;
    }
    claim.updatedBy = req.user._id;
    claim.revision += 1;
    await claim.save();
    await audit(req, claim, 'billing.claim_draft_updated');
    return res.json({ success: true, data: claim });
  } catch (error) { return fail(res, error); }
};

exports.submit = async (req, res) => {
  try {
    const data = await claimService.submitClaim({
      hospitalId: requireHospitalId(req), claimId: req.params.id, amount: req.body.amount, user: req.user
    });
    await audit(req, data, 'billing.claim_submitted', { amount: data.amounts.claimSubmittedAmount });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.adjudicate = async (req, res) => {
  try {
    const data = await claimService.adjudicateClaim({ hospitalId: requireHospitalId(req), claimId: req.params.id, body: req.body, user: req.user });
    await audit(req, data, 'billing.claim_adjudicated', {
      approved: data.amounts.approvedSponsorAmount,
      deducted: data.amounts.deductedAmount
    });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.queryResponse = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const claim = await ClaimCase.findOne({ _id: req.params.id, hospitalId });
    if (!claim) return res.status(404).json({ success: false, error: 'Claim not found' });
    claim.queries = claim.queries || [];
    if (req.body.queryNumber && req.body.response) {
      const existing = claim.queries.find((row) => row.queryNumber === req.body.queryNumber);
      if (existing) {
        existing.externalQueryId = req.body.externalQueryId ?? existing.externalQueryId;
        existing.category = req.body.category ?? existing.category;
        existing.reasonCode = req.body.reasonCode ?? existing.reasonCode;
        existing.response = req.body.response;
        if (req.body.documentsAdded) existing.documentsAdded = req.body.documentsAdded;
        existing.respondedAt = new Date();
        existing.respondedBy = req.user._id;
        existing.status = req.body.close ? 'closed' : 'responded';
      } else {
        claim.queries.push({
          queryNumber: req.body.queryNumber,
          externalQueryId: req.body.externalQueryId,
          category: req.body.category,
          reasonCode: req.body.reasonCode,
          text: req.body.text,
          receivedAt: req.body.receivedAt || new Date(),
          dueAt: req.body.dueAt,
          response: req.body.response,
          documentsAdded: req.body.documentsAdded || [],
          respondedAt: new Date(),
          respondedBy: req.user._id,
          status: req.body.close ? 'closed' : 'responded'
        });
      }
    } else {
      claim.queries.push({
        queryNumber: req.body.queryNumber || `Q-${Date.now()}`,
        externalQueryId: req.body.externalQueryId,
        category: req.body.category,
        reasonCode: req.body.reasonCode,
        text: req.body.text,
        receivedAt: req.body.receivedAt || new Date(),
        dueAt: req.body.dueAt,
        status: 'open'
      });
    }
    claim.status = 'query';
    claim.updatedBy = req.user._id;
    claim.revision += 1;
    await claim.save();
    await audit(req, claim, 'billing.claim_query_updated', { queryNumber: req.body.queryNumber });
    return res.json({ success: true, data: claim });
  } catch (error) { return fail(res, error); }
};

exports.settlement = async (req, res) => {
  try {
    const data = await claimService.recordSettlement({ hospitalId: requireHospitalId(req), claimId: req.params.id, body: req.body, user: req.user });
    await audit(req, data, data.status === 'settled' ? 'billing.claim_settled' : 'billing.claim_partially_settled', {
      paid: data.amounts.sponsorPaidAmount,
      outstanding: data.amounts.outstandingSponsorAmount
    });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.cancel = async (req, res) => {
  try {
    const claim = await claimService.cancelClaim({
      hospitalId: requireHospitalId(req),
      claimId: req.params.id,
      reason: req.body.reason,
      user: req.user
    });
    await audit(req, claim, 'billing.claim_cancelled', { reason: req.body.reason });
    return res.json({ success: true, data: claim });
  } catch (error) { return fail(res, error); }
};

exports.report = async (req, res) => {
  try {
    const data = await claimService.report({ hospitalId: requireHospitalId(req), query: req.query });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

exports.ledger = async (req, res) => {
  try {
    const data = await claimService.ledgerReport({ hospitalId: requireHospitalId(req), query: req.query });
    res.json({ success: true, data });
  } catch (error) { fail(res, error); }
};

function csvEscape(value) {
  const text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

exports.exportReport = async (req, res) => {
  try {
    const { rows, summary } = await claimService.report({ hospitalId: requireHospitalId(req), query: req.query });
    const format = String(req.query.format || 'xlsx').toLowerCase();
    if (format === 'csv') {
      const columns = Object.keys(rows[0] || {
        claimNumber: '', patientName: '', payerName: '', description: '', sponsorLiability: '', patientLiability: ''
      });
      const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="claims-service-ledger.csv"');
      return res.send(`\uFEFF${csv}`);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'HIMS';
    const detail = workbook.addWorksheet('Claim Service Ledger');
    const detailColumns = Object.keys(rows[0] || {
      claimNumber: '', patientName: '', payerName: '', description: '', sponsorLiability: '', patientLiability: ''
    });
    detail.columns = detailColumns.map((key) => ({ header: key, key, width: Math.max(14, Math.min(40, key.length + 4)) }));
    rows.forEach((row) => detail.addRow(row));
    detail.views = [{ state: 'frozen', ySplit: 1 }];
    detail.autoFilter = { from: 'A1', to: `${detail.getColumn(detailColumns.length).letter}1` };

    const payer = workbook.addWorksheet('Payer Summary');
    const summaryColumns = Object.keys(summary[0] || { payerCode: '', payerName: '', claims: '', submitted: '', approved: '', paid: '', outstanding: '' });
    payer.columns = summaryColumns.map((key) => ({ header: key, key, width: Math.max(14, key.length + 4) }));
    summary.forEach((row) => payer.addRow(row));
    payer.views = [{ state: 'frozen', ySplit: 1 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="claims-mis-report.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) { return fail(res, error); }
};

exports.exportLedger = async (req, res) => {
  try {
    const entries = await claimService.ledgerReport({ hospitalId: requireHospitalId(req), query: req.query });
    const rows = entries.map((entry) => ({
      occurredAt: entry.occurredAt,
      entryNumber: entry.entryNumber,
      payerCode: entry.payerId?.code,
      payerName: entry.payerId?.name,
      claimNumber: entry.claimId?.claimNumber,
      encounter: entry.admissionId?.admissionNumber || entry.appointmentId?.token,
      patient: [entry.patientId?.first_name, entry.patientId?.last_name].filter(Boolean).join(' '),
      entryType: entry.entryType,
      debit: entry.debit,
      credit: entry.credit,
      balanceAfter: entry.balanceAfter,
      reference: entry.reference,
      reason: entry.reason,
      reconciliationStatus: entry.reconciliationStatus
    }));
    const columns = Object.keys(rows[0] || { occurredAt: '', entryNumber: '', payerName: '', debit: '', credit: '', balanceAfter: '' });
    const csv = [columns.join(','), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sponsor-ledger.csv"');
    return res.send(`\uFEFF${csv}`);
  } catch (error) { return fail(res, error); }
};
