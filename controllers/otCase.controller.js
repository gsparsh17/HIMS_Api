const { operationNow } = require('../utils/operationTimeContext');
const { semanticDateRange } = require('../utils/hospitalDateRange');
const mongoose = require('mongoose');
const OTRequest = require('../models/OTRequest');
const OTSchedule = require('../models/OTSchedule');
const OTReadinessChecklist = require('../models/OTReadinessChecklist');
const OTSurgicalSafetyChecklist = require('../models/OTSurgicalSafetyChecklist');
const OTPreAnaesthesiaAssessment = require('../models/OTPreAnaesthesiaAssessment');
const OTAnesthesiaRecord = require('../models/OTAnesthesiaRecord');
const OTOperativeNote = require('../models/OTOperativeNote');
const OTRecoveryRecord = require('../models/OTRecoveryRecord');
const OTCaseInventoryUsage = require('../models/OTCaseInventoryUsage');
const OTSpecimen = require('../models/OTSpecimen');
const OTAdditionalProcedure = require('../models/OTAdditionalProcedure');
const StoreLocation = require('../models/StoreLocation');
const StoreItem = require('../models/StoreItem');
const InventoryLot = require('../models/InventoryLot');
const IPDAdmission = require('../models/IPDAdmission');
const Procedure = require('../models/Procedure');
const { reverseSourceFinancials } = require('../services/chargePosting.service');
const Room = require('../models/Room');
const { requireHospitalId } = require('../services/tenantScope.service');
const { transitionDocument, transitionError } = require('../services/workflowTransition.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const patientFileManifest = require('../services/patientFileManifest.service');
const {
  decorateCase, queryStatusesForCanonical, legacyActionForStatus, buildTransitionDefinitions,
  financialCanProceed, canonicalStatus, OT_WORKFLOW_POLICY_VERSION
} = require('../services/otWorkflow.service');
const { getOrCreateReadiness, evaluateReadiness, reconcileOtReadiness, DERIVED_READINESS_KEYS } = require('../services/otReadiness.service');
const { ensureOTFinancialObligation, refreshOTFinancialState } = require('../services/otFinancialClearance.service');
const { findSchedulingConflicts, teamAssignments, validateDuration, clampMinutes } = require('../services/otScheduling.service');
const { _hasActionPermission } = require('../middlewares/auth');
const { saveInventoryUsage } = require('../services/otInventoryIntegration.service');
const { ensurePathologyOrder } = require('../services/otPathology.service');
const { addAdditionalProcedure } = require('../services/otAdditionalProcedure.service');
const { clinicalClosureCheck, financialReconciliation, validateClinicalPayload } = require('../services/otClinicalCompletion.service');


const DEFAULT_SAFETY = {
  signIn: [
    ['identity', 'Patient identity, procedure, site and consent confirmed'],
    ['site_marked', 'Site marked or not applicable'],
    ['machine_check', 'Anaesthesia machine and medication check complete'],
    ['allergy', 'Known allergy reviewed'],
    ['airway_blood_loss', 'Difficult airway and blood-loss risk reviewed']
  ],
  timeOut: [
    ['team_introduction', 'All team members introduced by name and role'],
    ['procedure_reconfirm', 'Patient, procedure and incision site reconfirmed'],
    ['antibiotic', 'Antibiotic prophylaxis given within policy window'],
    ['critical_events', 'Anticipated critical events discussed'],
    ['imaging', 'Essential imaging displayed where applicable']
  ],
  signOut: [
    ['procedure_recorded', 'Procedure name recorded'],
    ['counts_complete', 'Instrument, sponge and needle counts complete'],
    ['specimen_labelled', 'Specimens labelled and handed over'],
    ['equipment_issues', 'Equipment problems documented'],
    ['recovery_plan', 'Recovery and post-operative plan reviewed']
  ]
};

function safetySection(items) {
  return { status: 'Pending', items: items.map(([key, label]) => ({ key, label, response: '' })) };
}

function booleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

function parseDateTime(dateValue, timeValue) {
  if (!dateValue) return null;
  if (String(dateValue).includes('T') && !timeValue) return new Date(dateValue);
  const date = new Date(dateValue);
  const [hours, minutes] = String(timeValue || '00:00').split(':').map(Number);
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date;
}

function casePopulate(query) {
  return query
    .populate('patientId', 'first_name last_name name patientId patient_id uhid dob date_of_birth age gender phone address')
    .populate('doctorId primarySurgeonId assistantSurgeonId anesthetistId', 'firstName lastName first_name last_name name specialization registration_number')
    .populate('scrubNurseId circulatingNurseId', 'first_name last_name name')
    .populate('otStaffId', 'employeeId designation qualification')
    .populate('otRoomId', 'room_number roomNumber type floor status')
    .populate('admissionId', 'admissionNumber shipNumber status admissionDate dischargeDate wardId roomId bedId');
}

async function findCase(req, id, session) {
  const hospitalId = requireHospitalId(req);
  const query = OTRequest.findOne({ _id: id, hospitalId });
  if (session) query.session(session);
  const otCase = await query;
  if (!otCase) throw Object.assign(new Error('OT case not found'), { statusCode: 404 });
  return otCase;
}

async function getOrCreateSafety(otCase) {
  let checklist = await OTSurgicalSafetyChecklist.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id });
  if (!checklist) {
    checklist = await OTSurgicalSafetyChecklist.create({
      hospitalId: otCase.hospitalId,
      caseId: otCase._id,
      admissionId: otCase.admissionId,
      patientId: otCase.patientId,
      signIn: safetySection(DEFAULT_SAFETY.signIn),
      timeOut: safetySection(DEFAULT_SAFETY.timeOut),
      signOut: safetySection(DEFAULT_SAFETY.signOut)
    });
  }
  return checklist;
}

exports.createCase = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const admission = await IPDAdmission.findOne({ _id: req.body.admissionId, hospitalId });
    if (!admission) return res.status(404).json({ error: 'IPD admission not found' });
    if (['Discharged', 'Cancelled', 'LAMA', 'DAMA', 'Expired'].includes(admission.status)) {
      return res.status(400).json({ error: `Cannot create OT case: IPD admission status is ${admission.status}` });
    }
    const patientId = req.body.patientId || admission.patientId;
    if (String(patientId) !== String(admission.patientId)) return res.status(400).json({ error: 'Patient does not match admission' });

    const idempotencyKey = String(req.body.idempotencyKey || req.get('Idempotency-Key') || '').trim();
    if (idempotencyKey) {
      const existing = await OTRequest.findOne({ hospitalId, idempotencyKey });
      if (existing) {
        await getOrCreateSafety(existing);
        const existingCanonicalStatus = canonicalStatus(existing.status, existing);
        const financial = ['Closed', 'Cancelled'].includes(existingCanonicalStatus)
          ? await refreshOTFinancialState({ otCase: existing, user: req.user, syncReadiness: true })
          : await ensureOTFinancialObligation({
            otCase: existing,
            user: req.user,
            selectedMode: req.body.selectedMode,
            requestedDeposit: req.body.requestedDeposit,
            adjustments: {
              discountType: req.body.discountType, discountRate: req.body.discountRate, discountAmount: req.body.discountAmount,
              discountValue: req.body.discountValue, discountReason: req.body.discountReason, taxMode: req.body.taxMode,
              taxRate: req.body.taxRate, taxReason: req.body.taxReason
            },
            overrideReason: req.body.overrideReason
          });
        const populatedExisting = await casePopulate(OTRequest.findById(existing._id));
        return res.json({
          success: true,
          reused: true,
          message: 'Existing OT case resumed',
          data: decorateCase(populatedExisting),
          financial: financial.summary,
          readiness: financial.readiness
        });
      }
    }

    let procedure = null;
    if (req.body.procedureId) {
      procedure = await Procedure.findOne({ _id: req.body.procedureId, hospitalId, is_active: { $ne: false }, is_billable: { $ne: false } });
    }
    if (!procedure && req.body.procedureCode) {
      procedure = await Procedure.findOne({ hospitalId, code: String(req.body.procedureCode).trim().toUpperCase(), is_active: { $ne: false }, is_billable: { $ne: false } });
    }
    if (!procedure) {
      const error = new Error('Select an active billable procedure from the hospital Procedure master before creating an OT case');
      error.statusCode = 409;
      error.code = 'SOURCE_SERVICE_MASTER_REQUIRED';
      throw error;
    }

    const otCase = await OTRequest.create({
      ...req.body,
      hospitalId,
      idempotencyKey: idempotencyKey || undefined,
      encounterType: 'IPD',
      encounterId: admission._id,
      admissionId: admission._id,
      patientId,
      doctorId: req.body.doctorId || admission.primaryDoctorId,
      procedureId: procedure._id,
      procedureCode: procedure.code,
      procedureName: procedure.name,
      procedureCategory: procedure.category,
      estimated_duration_minutes: Number(req.body.estimated_duration_minutes || procedure.duration_minutes || 60),
      status: 'Readiness Pending',
      readinessStatus: 'Pending',
      workflowPolicyVersion: OT_WORKFLOW_POLICY_VERSION,
      paymentStatus: 'Pending',
      total_cost: 0,
      estimated_cost: 0,
      createdBy: req.user._id
    });

    await getOrCreateReadiness(otCase, req.user._id);
    await getOrCreateSafety(otCase);

    let financial;
    try {
      financial = await ensureOTFinancialObligation({
        otCase,
        user: req.user,
        selectedMode: req.body.selectedMode,
        requestedDeposit: req.body.requestedDeposit,
        adjustments: {
          discountType: req.body.discountType, discountRate: req.body.discountRate, discountAmount: req.body.discountAmount,
          discountValue: req.body.discountValue, discountReason: req.body.discountReason, taxMode: req.body.taxMode,
          taxRate: req.body.taxRate, taxReason: req.body.taxReason
        },
        overrideReason: req.body.overrideReason
      });
    } catch (financeError) {
      // Keep the case recoverable if financial posting partially succeeded. The
      // idempotency key allows the same request to safely resume later.
      otCase.financialClearanceState = 'HOLD';
      otCase.billingClosureStatus = 'Pending';
      await otCase.save();
      financeError.details = { ...(financeError.details || {}), otCaseId: String(otCase._id), requestNumber: otCase.requestNumber };
      throw financeError;
    }

    await appendDomainEvent({
      req,
      eventType: 'ot.case.requested',
      entityType: 'OTRequest',
      entityId: otCase._id,
      hospitalId,
      patientId,
      encounterId: admission._id,
      afterSummary: {
        requestNumber: otCase.requestNumber,
        procedureId: procedure._id,
        procedureName: procedure.name,
        status: otCase.status,
        financialClearanceState: otCase.financialClearanceState
      }
    });
    const populated = await casePopulate(OTRequest.findById(otCase._id));
    return res.status(201).json({
      success: true,
      message: 'OT case created with Procedure-master pricing, financial obligation and readiness workflow',
      data: decorateCase(populated),
      financial: financial.summary,
      readiness: financial.readiness
    });
  } catch (error) { next(error); }
};

exports.listCases = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const filter = { hospitalId };
    const statusValues = String(req.query.statuses || req.query.status || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (statusValues.length) filter.status = { $in: queryStatusesForCanonical(statusValues) };
    for (const field of ['paymentStatus', 'admissionId', 'patientId', 'doctorId', 'urgency', 'otRoomId', 'financialClearanceState']) {
      if (req.query[field]) filter[field] = req.query[field];
    }
    if (req.query.startDate || req.query.endDate) {
      filter.requestedDate = semanticDateRange(req.query.startDate, req.query.endDate);
    }
    const [data, total] = await Promise.all([
      casePopulate(OTRequest.find(filter)).sort({ scheduledStart: 1, requestedDate: -1 }).skip((page - 1) * limit).limit(limit),
      OTRequest.countDocuments(filter)
    ]);
    res.json({ success: true, data: data.map(decorateCase), total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
};

exports.getCase = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await casePopulate(OTRequest.findOne({ _id: req.params.id, hospitalId }));
    if (!otCase) return res.status(404).json({ error: 'OT case not found' });
    res.json({ success: true, data: decorateCase(otCase) });
  } catch (error) { next(error); }
};

exports.getWorkspace = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const financial = await refreshOTFinancialState({ otCase, user: req.user, syncReadiness: true });
    const filter = { hospitalId: otCase.hospitalId, caseId: otCase._id };
    const [safety, pac, anesthesia, operative, recovery, inventory, specimens, schedule, additionalProcedures, reconciliation] = await Promise.all([
      getOrCreateSafety(otCase),
      OTPreAnaesthesiaAssessment.findOne(filter), OTAnesthesiaRecord.findOne(filter), OTOperativeNote.findOne(filter),
      OTRecoveryRecord.findOne(filter), OTCaseInventoryUsage.findOne(filter).populate('sourceLocationId', 'code name type').populate('lines.itemId lines.lotId lines.billingChargeId'),
      OTSpecimen.find(filter).populate('pathologyOrderId', 'requestNumber status testName').populate('pathologyLabTestId', 'code name category').sort({ createdAt: 1 }),
      OTSchedule.findOne({ hospitalId: otCase.hospitalId, requestId: otCase._id }),
      OTAdditionalProcedure.find(filter).populate('procedureId', 'code name category base_price').populate('billingChargeId', 'description netAmount patientLiability sponsorLiability').sort({ createdAt: 1 }),
      financialReconciliation(otCase)
    ]);
    otCase.financialReconciliationStatus = reconciliation.status;
    otCase.financialReconciliationSummary = reconciliation;
    await otCase.save();
    const populated = await casePopulate(OTRequest.findById(otCase._id));
    res.json({
      success: true,
      data: {
        case: decorateCase(populated, { safety }),
        financial: { ...financial.summary, reconciliation },
        readiness: financial.readiness,
        safety, pac, anesthesia, operative, recovery, inventory, specimens, schedule, additionalProcedures
      }
    });
  } catch (error) { next(error); }
};

exports.getFinancial = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const financial = await refreshOTFinancialState({ otCase, user: req.user, syncReadiness: true });
    const populated = await casePopulate(OTRequest.findById(otCase._id));
    res.json({ success: true, data: financial.summary, case: decorateCase(populated), readiness: financial.readiness });
  } catch (error) { next(error); }
};

exports.getReadiness = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    await refreshOTFinancialState({ otCase, user: req.user, syncReadiness: false });
    const checklist = await reconcileOtReadiness({ otCase, userId: req.user._id, autoApprove: true });
    res.json({ success: true, data: checklist, case: decorateCase(otCase) });
  } catch (error) { next(error); }
};

exports.updateReadiness = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    // Derived readiness items are reconciled from their source records first.
    await refreshOTFinancialState({ otCase, user: req.user, syncReadiness: false });
    const checklist = await reconcileOtReadiness({ otCase, userId: req.user._id, autoApprove: false });
    const updates = new Map((req.body.items || []).map((item) => [item.key, item]));
    checklist.items.forEach((item) => {
      if (DERIVED_READINESS_KEYS.includes(item.key)) return;
      const update = updates.get(item.key);
      if (!update) return;
      if (update.status === 'Bypassed') {
        if (!String(update.bypassReason || update.notes || '').trim()) throw transitionError(`A bypass reason is required for ${item.label}`, 400);
        if (!_hasActionPermission(req.user, 'ot_emergency_bypass')) throw transitionError(`You are not permitted to bypass ${item.label}`, 403);
      }
      item.status = update.status || item.status;
      item.value = update.value;
      item.notes = update.notes;
      item.completedBy = req.user._id;
      item.completedAt = ['Complete', 'Not Applicable', 'Bypassed'].includes(item.status) ? operationNow() : undefined;
      item.bypassReason = update.bypassReason;
      item.bypassApprovedBy = item.status === 'Bypassed' ? req.user._id : undefined;
    });
    checklist.evaluatedBy = req.user._id;
    evaluateReadiness(checklist);
    await checklist.save();
    const reconciled = await reconcileOtReadiness({ otCase, userId: req.user._id, autoApprove: true });
    otCase.readinessStatus = reconciled.overallStatus;
    await otCase.save();
    await appendDomainEvent({ req, eventType: 'ot.case.readiness_updated', entityType: 'OTReadinessChecklist', entityId: checklist._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, revision: checklist.version, afterSummary: { overallStatus: otCase.readinessStatus, financialClearanceState: otCase.financialClearanceState } });
    res.json({ success: true, message: `Readiness is ${otCase.readinessStatus}`, data: await getOrCreateReadiness(otCase, req.user._id), case: decorateCase(otCase) });
  } catch (error) { next(error); }
};

exports.getSafety = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    res.json({ success: true, data: await getOrCreateSafety(otCase) });
  } catch (error) { next(error); }
};

exports.updateSafety = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const checklist = await getOrCreateSafety(otCase);
    const sectionName = req.body.section;
    if (!['signIn', 'timeOut', 'signOut'].includes(sectionName)) return res.status(400).json({ error: 'Invalid safety checklist section' });
    const canonical = canonicalStatus(otCase.status, otCase);
    const allowedStatuses = {
      signIn: ['Scheduled', 'Patient Received'],
      timeOut: ['Patient Received', 'In Progress'],
      signOut: ['In Progress']
    };
    if (!allowedStatuses[sectionName].includes(canonical)) {
      throw transitionError(`${sectionName} cannot be completed while OT case status is ${canonical}`, 409, { allowedStatuses: allowedStatuses[sectionName] });
    }
    const section = checklist[sectionName];
    const updates = new Map((req.body.items || []).map((item) => [item.key, item]));
    section.items.forEach((item) => {
      const update = updates.get(item.key);
      if (!update) return;
      item.response = update.response;
      item.notes = update.notes;
      item.completedBy = req.user._id;
      item.completedAt = operationNow();
    });
    const incomplete = section.items.filter((item) => !['Yes', 'Not Applicable'].includes(item.response));
    if (req.body.bypass) {
      if (!String(req.body.bypassReason || '').trim()) throw transitionError('Safety bypass reason is required', 400);
      if (!_hasActionPermission(req.user, 'ot_emergency_bypass')) throw transitionError('You are not permitted to bypass the surgical safety checklist', 403);
      section.status = 'Bypassed';
      section.bypassReason = String(req.body.bypassReason).trim();
      section.bypassApprovedBy = req.user._id;
    } else {
      section.status = incomplete.length ? 'Pending' : 'Completed';
    }
    section.attestedBy = req.user._id;
    section.attestedAt = operationNow();
    checklist.version = Number(checklist.version || 0) + 1;
    await checklist.save();
    await appendDomainEvent({
      req, eventType: `ot.safety.${sectionName}.${section.status.toLowerCase()}`, entityType: 'OTSurgicalSafetyChecklist',
      entityId: checklist._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId,
      revision: checklist.version, afterSummary: { section: sectionName, status: section.status }
    });
    res.json({ success: true, data: checklist, case: decorateCase(otCase, { safety: checklist }) });
  } catch (error) { next(error); }
};

async function evaluateScheduleRequest(req, otCase, session, { persistCase = true } = {}) {
  await refreshOTFinancialState({ otCase, user: req.user, session, syncReadiness: false });
  await reconcileOtReadiness({ otCase, userId: req.user._id, session, autoApprove: true, saveCase: false });
  if (persistCase) await otCase.save(session ? { session } : undefined);

  const canonical = canonicalStatus(otCase.status, otCase);
  if (!['Approved', 'Scheduled', 'Postponed'].includes(canonical)) {
    throw transitionError(`Case cannot be scheduled while status is ${canonical}`);
  }
  if (!['Ready', 'Ready With Bypass'].includes(otCase.readinessStatus) && !otCase.emergencyOverride?.enabled) {
    throw transitionError('OT readiness is incomplete');
  }
  if (!financialCanProceed(otCase.financialClearanceState, otCase)) {
    throw transitionError(`Financial clearance is required before scheduling (${otCase.financialClearanceState || 'PAYMENT_REQUIRED'})`);
  }

  const scheduledStart = parseDateTime(req.body.scheduledStart || req.body.scheduledDate, req.body.scheduledTime);
  if (!scheduledStart || Number.isNaN(scheduledStart.getTime())) throw Object.assign(new Error('Valid schedule start is required'), { statusCode: 400 });
  const duration = validateDuration(req.body.durationMinutes || req.body.estimated_duration_minutes || otCase.estimated_duration_minutes || 60);
  const scheduledEnd = req.body.scheduledEnd ? new Date(req.body.scheduledEnd) : new Date(scheduledStart.getTime() + duration * 60000);
  if (Number.isNaN(scheduledEnd.getTime()) || scheduledEnd <= scheduledStart) throw Object.assign(new Error('Valid schedule end is required'), { statusCode: 400 });
  const roomId = req.body.otRoomId || otCase.otRoomId;
  if (!roomId) throw Object.assign(new Error('OT room is required'), { statusCode: 400 });
  const roomQuery = Room.findOne({ _id: roomId, hospitalId: otCase.hospitalId });
  if (session) roomQuery.session(session);
  const room = await roomQuery;
  if (!room || !['Operation Theater', 'Operation Theatre', 'OT'].includes(room.type) || ['Maintenance', 'Closed'].includes(room.status) || ['maintenance', 'closed'].includes(room.operationalStatus)) {
    throw Object.assign(new Error('Valid operational theatre room not found'), { statusCode: 404 });
  }

  const setupBufferMinutes = clampMinutes(req.body.setupBufferMinutes ?? otCase.setupBufferMinutes ?? 15, 15);
  const cleaningBufferMinutes = clampMinutes(req.body.cleaningBufferMinutes ?? otCase.cleaningBufferMinutes ?? 20, 20);
  const suppliedOrExisting = (field, fallback) => Object.prototype.hasOwnProperty.call(req.body, field)
    ? (req.body[field] || null)
    : fallback;
  const team = {
    primarySurgeonId: suppliedOrExisting('primarySurgeonId', otCase.primarySurgeonId || otCase.doctorId),
    assistantSurgeonId: suppliedOrExisting('assistantSurgeonId', otCase.assistantSurgeonId),
    anesthetistId: suppliedOrExisting('anesthetistId', otCase.anesthetistId),
    scrubNurseId: suppliedOrExisting('scrubNurseId', otCase.scrubNurseId),
    circulatingNurseId: suppliedOrExisting('circulatingNurseId', otCase.circulatingNurseId),
    otStaffId: suppliedOrExisting('otStaffId', otCase.otStaffId)
  };
  const availability = await findSchedulingConflicts({
    hospitalId: otCase.hospitalId,
    requestId: otCase._id,
    roomId,
    scheduledStart,
    scheduledEnd,
    setupBufferMinutes,
    cleaningBufferMinutes,
    team,
    session
  });
  return { room, roomId, scheduledStart, scheduledEnd, duration, setupBufferMinutes, cleaningBufferMinutes, team, availability };
}

exports.previewSchedule = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const plan = await evaluateScheduleRequest(req, otCase, undefined, { persistCase: false });
    res.json({
      success: true,
      available: plan.availability.conflicts.length === 0,
      conflicts: plan.availability.conflicts,
      blockedStart: plan.availability.blockedStart,
      blockedEnd: plan.availability.blockedEnd,
      readinessStatus: otCase.readinessStatus,
      financialClearanceState: otCase.financialClearanceState
    });
  } catch (error) { next(error); }
};

exports.scheduleCase = async (req, res, next) => {
  let session;
  try {
    const hospitalId = requireHospitalId(req);
    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      const otCase = await findCase(req, req.params.id, session);
      const plan = await evaluateScheduleRequest(req, otCase, session);
      if (plan.availability.conflicts.length) {
        throw transitionError('The selected OT slot or team has scheduling conflicts', 409, {
          conflicts: plan.availability.conflicts,
          blockedStart: plan.availability.blockedStart,
          blockedEnd: plan.availability.blockedEnd
        });
      }

      const currentSchedule = await OTSchedule.findOne({ hospitalId, requestId: otCase._id }).session(session);
      const changed = Boolean(currentSchedule && (
        String(currentSchedule.otRoomId) !== String(plan.roomId)
        || new Date(currentSchedule.scheduledStart).getTime() !== plan.scheduledStart.getTime()
        || new Date(currentSchedule.scheduledEnd).getTime() !== plan.scheduledEnd.getTime()
      ));
      const rescheduleReason = String(req.body.rescheduleReason || req.body.reason || '').trim();
      if (changed && !rescheduleReason) throw transitionError('A reschedule reason is required when changing an existing OT slot', 400);

      const teamSnapshot = teamAssignments(plan.team).map((member) => ({
        role: member.role,
        resourceType: member.kind,
        userId: member.id
      }));
      const update = {
        $set: {
          hospitalId,
          otRoomId: plan.roomId,
          requestId: otCase._id,
          scheduledDate: plan.scheduledStart,
          startTime: plan.scheduledStart.toTimeString().slice(0, 5),
          endTime: plan.scheduledEnd.toTimeString().slice(0, 5),
          scheduledStart: plan.scheduledStart,
          scheduledEnd: plan.scheduledEnd,
          blockedStart: plan.availability.blockedStart,
          blockedEnd: plan.availability.blockedEnd,
          duration_minutes: plan.duration,
          setupBufferMinutes: plan.setupBufferMinutes,
          cleaningBufferMinutes: plan.cleaningBufferMinutes,
          conflictKey: `${plan.roomId}:${plan.availability.blockedStart.toISOString()}:${plan.availability.blockedEnd.toISOString()}`,
          status: 'Scheduled',
          notes: req.body.notes,
          rescheduleReason: changed ? rescheduleReason : undefined,
          teamSnapshot,
          assignedBy: req.user._id
        },
        $inc: { version: 1 }
      };
      if (currentSchedule && changed) {
        update.$push = {
          history: {
            version: currentSchedule.version,
            status: currentSchedule.status,
            otRoomId: currentSchedule.otRoomId,
            scheduledStart: currentSchedule.scheduledStart,
            scheduledEnd: currentSchedule.scheduledEnd,
            blockedStart: currentSchedule.blockedStart,
            blockedEnd: currentSchedule.blockedEnd,
            setupBufferMinutes: currentSchedule.setupBufferMinutes,
            cleaningBufferMinutes: currentSchedule.cleaningBufferMinutes,
            duration_minutes: currentSchedule.duration_minutes,
            teamSnapshot: currentSchedule.teamSnapshot,
            changedAt: operationNow(),
            changedBy: req.user._id,
            reason: rescheduleReason
          }
        };
      }
      const schedule = await OTSchedule.findOneAndUpdate(
        { hospitalId, requestId: otCase._id },
        update,
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );

      Object.assign(otCase, {
        otRoomId: plan.roomId,
        scheduledDate: plan.scheduledStart,
        scheduledTime: schedule.startTime,
        scheduledStart: plan.scheduledStart,
        scheduledEnd: plan.scheduledEnd,
        estimated_duration_minutes: plan.duration,
        setupBufferMinutes: plan.setupBufferMinutes,
        cleaningBufferMinutes: plan.cleaningBufferMinutes,
        ...plan.team,
        status: 'Scheduled',
        version: Number(otCase.version || 0) + 1
      });
      await otCase.save({ session });
      await appendDomainEvent({
        req,
        eventType: changed ? 'ot.case.rescheduled' : 'ot.case.scheduled',
        entityType: 'OTRequest',
        entityId: otCase._id,
        hospitalId,
        patientId: otCase.patientId,
        encounterId: otCase.admissionId,
        revision: otCase.version,
        afterSummary: {
          scheduledStart: plan.scheduledStart,
          scheduledEnd: plan.scheduledEnd,
          blockedStart: plan.availability.blockedStart,
          blockedEnd: plan.availability.blockedEnd,
          roomId: plan.roomId,
          rescheduleReason: changed ? rescheduleReason : undefined
        },
        session
      });
      result = { otCase, schedule, changed };
    });
    res.json({ success: true, message: result.changed ? 'OT case rescheduled' : 'OT case scheduled', data: decorateCase(result.otCase), schedule: result.schedule });
  } catch (error) { next(error); } finally { if (session) await session.endSession(); }
};

const transitions = buildTransitionDefinitions({
  receiptGuard: (_doc, req) => {
    const required = ['identityConfirmed', 'procedureConfirmed', 'siteConfirmed', 'handoverReceived'];
    const missing = required.filter((key) => req.body[key] !== true);
    if (missing.length) return `Patient receipt confirmation is incomplete: ${missing.join(', ')}`;
    return true;
  },
  safetyGuard: async (stage, doc) => {
    const checklist = await getOrCreateSafety(doc);
    if (stage === 'start') {
      return ['Completed', 'Bypassed'].includes(checklist.signIn?.status)
        ? true
        : 'WHO Surgical Safety Sign In must be completed or formally bypassed before surgery starts';
    }
    if (stage === 'recover') {
      if (!['Completed', 'Bypassed'].includes(checklist.timeOut?.status)) return 'WHO Surgical Safety Time Out must be completed or formally bypassed before recovery';
      if (!['Completed', 'Bypassed'].includes(checklist.signOut?.status)) return 'WHO Surgical Safety Sign Out must be completed or formally bypassed before recovery';
    }
    return true;
  },
  transferGuard: async (doc) => {
    const recovery = await OTRecoveryRecord.findOne({ hospitalId: doc.hospitalId, caseId: doc._id });
    if (!recovery) return 'Recovery record is required before transfer';
    const threshold = Math.max(0, Number(process.env.OT_RECOVERY_MIN_ALDRETE || 9));
    if (!doc.emergencyOverride?.enabled) {
      if (!recovery.dischargeCriteriaMet) return 'Recovery discharge criteria are not met';
      if (Number(recovery.finalAldreteScore || 0) < threshold) return `Final Aldrete score must be at least ${threshold} before transfer`;
    }
    if (!recovery.disposition) return 'Recovery destination/disposition is required before transfer';
    return true;
  },
  closeGuard: async (doc) => {
    const clinical = await clinicalClosureCheck(doc);
    if (!clinical.ok) return clinical.errors.join('; ');
    const reconciliation = await financialReconciliation(doc);
    if (reconciliation.status !== 'Reconciled') return `OT financial reconciliation is incomplete: ${reconciliation.billingFailures.join(', ') || 'review required'}`;
    doc.financialReconciliationStatus = reconciliation.status;
    doc.financialReconciliationSummary = reconciliation;
    doc.billingClosureStatus = 'Cleared';
    return true;
  }
});

exports.transitionCase = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const action = req.params.action || req.body.action;
    if (action === 'approve' && !_hasActionPermission(req.user, 'ot_approve')) throw transitionError('You are not permitted to manually approve OT cases', 403);
    if (['cancel', 'postpone'].includes(action) && !String(req.body.reason || '').trim()) throw transitionError(`A reason is required to ${action} an OT case`, 400);
    if (['approve', 'receive'].includes(action)) {
      await refreshOTFinancialState({ otCase, user: req.user, syncReadiness: false });
      await reconcileOtReadiness({ otCase, userId: req.user._id, autoApprove: action !== 'approve' });
    }
    let sharedTransfer = null;
    if (action === 'transfer') {
      const recovery = await OTRecoveryRecord.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id });
      const toBedId = req.body.toBedId || req.body.post_op_bedId;
      if (toBedId) {
        const transferService = require('../services/ipdTransfer.service');
        sharedTransfer = await transferService.transaction(async (session) => {
          let row = await transferService.createTransfer({ req, hospitalId: otCase.hospitalId, admissionId: otCase.admissionId, payload: {
            toBedId, source: 'ot', reason: req.body.reason || `Post-operative transfer after ${otCase.procedureName || 'surgery'}`,
            priority: req.body.priority || 'urgent', patientCondition: req.body.patientCondition, oxygenRequired: req.body.oxygenRequired,
            isolationRequired: req.body.isolationRequired, equipmentNeeds: req.body.equipmentNeeds || [], handover: req.body.handover || {},
            idempotencyKey: req.body.idempotencyKey || `ot:${otCase._id}:transfer`
          }, session });
          row = await transferService.reserveTransfer({ req, hospitalId: otCase.hospitalId, transferId: row._id, expiresInMinutes: req.body.expiresInMinutes || 60, session });
          row = await transferService.approveTransfer({ req, hospitalId: otCase.hospitalId, transferId: row._id, note: req.body.approvalNote || 'Approved from canonical OT recovery workflow', session });
          row = await transferService.startTransfer({ req, hospitalId: otCase.hospitalId, transferId: row._id, handover: req.body.handover || { note: 'Post-operative handover' }, session });
          return transferService.completeTransfer({ req, hospitalId: otCase.hospitalId, transferId: row._id, payload: { conditionOnArrival: req.body.conditionOnArrival, note: req.body.note, actualEffectiveAt: req.body.actualEffectiveAt }, session });
        });
        req.body.disposition = req.body.disposition || recovery?.disposition || 'Ward';
      }
    }
    const updated = await transitionDocument({ document: otCase, action, definitions: transitions, req, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, reasonCode: req.body.reasonCode, comments: req.body.comments || req.body.reason, extraUpdate: action === 'cancel' ? { cancellationReason: req.body.reason } : action === 'postpone' ? { postponementReason: req.body.reason } : {} });
    if (action === 'recover') {
      await OTRecoveryRecord.findOneAndUpdate(
        { hospitalId: otCase.hospitalId, caseId: otCase._id },
        { $setOnInsert: { admissionId: otCase.admissionId, patientId: otCase.patientId }, $set: { receivedAt: operationNow(), receivedFrom: 'Operating Theatre', status: 'Monitoring' }, $inc: { version: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
    if (action === 'transfer') {
      const transferAt = sharedTransfer?.actualEffectiveAt || operationNow();
      await OTRecoveryRecord.findOneAndUpdate(
        { hospitalId: otCase.hospitalId, caseId: otCase._id },
        { $set: { transferAt, status: 'Transferred', disposition: req.body.disposition || undefined, handoverTo: req.body.handoverTo || undefined, postOpInstructions: req.body.postOpInstructions || undefined }, $inc: { version: 1 } }
      );
      if (sharedTransfer) {
        updated.transferId = sharedTransfer._id;
        updated.post_op_wardId = sharedTransfer.to?.wardId; updated.post_op_roomId = sharedTransfer.to?.roomId; updated.post_op_bedId = sharedTransfer.to?.bedId;
        updated.transferred_at = transferAt; updated.transferred_to_ward = true;
        await updated.save();
      }
    }
    if (action === 'close') {
      const reconciliation = await financialReconciliation(updated);
      updated.financialReconciliationStatus = reconciliation.status;
      updated.financialReconciliationSummary = reconciliation;
      updated.billingClosureStatus = reconciliation.status === 'Reconciled' ? 'Cleared' : 'Pending';
      await updated.save();
    }
    if (['cancel', 'postpone'].includes(action)) {
      const schedule = await OTSchedule.findOne({ hospitalId: otCase.hospitalId, requestId: otCase._id });
      if (schedule) {
        schedule.history = schedule.history || [];
        schedule.history.push({
          version: schedule.version, status: schedule.status, otRoomId: schedule.otRoomId, scheduledStart: schedule.scheduledStart, scheduledEnd: schedule.scheduledEnd,
          blockedStart: schedule.blockedStart, blockedEnd: schedule.blockedEnd, setupBufferMinutes: schedule.setupBufferMinutes, cleaningBufferMinutes: schedule.cleaningBufferMinutes,
          duration_minutes: schedule.duration_minutes, teamSnapshot: schedule.teamSnapshot, changedAt: operationNow(), changedBy: req.user._id, reason: req.body.reason
        });
        schedule.status = action === 'cancel' ? 'Cancelled' : 'Rescheduled';
        schedule.rescheduleReason = req.body.reason;
        schedule.version = Number(schedule.version || 0) + 1;
        await schedule.save();
      }
    }
    if (action === 'start') await OTSchedule.findOneAndUpdate({ hospitalId: otCase.hospitalId, requestId: otCase._id }, { $set: { status: 'In Progress' } });
    if (['recover', 'close'].includes(action)) await OTSchedule.findOneAndUpdate({ hospitalId: otCase.hospitalId, requestId: otCase._id }, { $set: { status: 'Completed' } });
    let financialReversal = null;
    if (action === 'cancel') {
      try {
        financialReversal = await reverseSourceFinancials({ sourceModule: 'OTRequest', sourceId: otCase._id, reason: req.body.reason || 'OT case cancelled', user: req.user });
      } catch (error) {
        if (error?.code !== 'FINANCE_REVERSAL_REQUIRED') throw error;
        financialReversal = { pendingFinanceAction: true, code: error.code, details: error.details };
        await OTRequest.updateOne({ _id: otCase._id, hospitalId: otCase.hospitalId }, { $set: { billingClosureStatus: 'Pending', financialClearanceState: 'HOLD' } });
      }
    }
    const safety = await getOrCreateSafety(updated);
    res.json({ success: true, message: `OT case ${action} completed`, data: decorateCase(updated, { safety }), financialReversal, transfer: sharedTransfer });
  } catch (error) { next(error); }
};

exports.setEmergencyOverride = async (req, res, next) => {
  try {
    if (!_hasActionPermission(req.user, 'ot_emergency_bypass')) throw transitionError('You are not permitted to manage OT emergency overrides', 403);
    const otCase = await findCase(req, req.params.id);
    const enabled = req.body.enabled !== false;
    const reason = String(req.body.reason || '').trim();
    if (enabled && !reason) throw transitionError('Emergency override reason is required', 400);
    if (['In Progress', 'Recovery', 'Transferred', 'Closed', 'Cancelled'].includes(canonicalStatus(otCase.status, otCase))) {
      throw transitionError('Emergency override can only be changed before surgery starts', 409);
    }
    otCase.emergencyOverride = enabled ? { enabled: true, reason, approvedBy: req.user._id, approvedAt: operationNow() } : { enabled: false };
    otCase.version = Number(otCase.version || 0) + 1;
    await otCase.save();
    await appendDomainEvent({ req, eventType: enabled ? 'ot.case.emergency_override_enabled' : 'ot.case.emergency_override_disabled', entityType: 'OTRequest', entityId: otCase._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, revision: otCase.version, comments: reason, afterSummary: { enabled, reason } });
    res.json({ success: true, data: decorateCase(otCase), message: enabled ? 'Emergency override enabled' : 'Emergency override disabled' });
  } catch (error) { next(error); }
};

exports.legacyStatusTransition = async (req, res, next) => {
  if (req.body.status === 'Scheduled') return res.status(400).json({ error: 'Use the schedule endpoint for Scheduled status' });
  const action = legacyActionForStatus(req.body.status);
  if (!action) return res.status(400).json({ error: `Legacy status ${req.body.status || '(empty)'} is not a supported OT transition` });
  req.params.action = action;
  return exports.transitionCase(req, res, next);
};

async function getForm(req, res, next, Model, createDefaults = {}) {
  try {
    const otCase = await findCase(req, req.params.id);
    let record = await Model.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id });
    if (!record && Object.keys(createDefaults).length) record = await Model.create({ hospitalId: otCase.hospitalId, caseId: otCase._id, admissionId: otCase.admissionId, patientId: otCase.patientId, ...createDefaults });
    res.json({ success: true, data: record });
  } catch (error) { next(error); }
}

async function saveForm(req, res, next, Model, eventType, afterSave) {
  try {
    const otCase = await findCase(req, req.params.id);
    const safe = { ...req.body };
    delete safe.hospitalId; delete safe.caseId; delete safe.admissionId; delete safe.patientId; delete safe._id;
    const record = await Model.findOneAndUpdate(
      { hospitalId: otCase.hospitalId, caseId: otCase._id },
      { $set: { ...safe, hospitalId: otCase.hospitalId, caseId: otCase._id, admissionId: otCase.admissionId, patientId: otCase.patientId }, $inc: { version: 1 } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    await appendDomainEvent({ req, eventType, entityType: Model.modelName, entityId: record._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, revision: record.version, afterSummary: { status: record.status || record.overallStatus } });
    const extra = afterSave ? await afterSave({ otCase, record, req }) : null;
    res.json({ success: true, message: 'OT clinical record saved', data: record, ...(extra || {}) });
  } catch (error) { next(error); }
}

exports.getPac = (req, res, next) => getForm(req, res, next, OTPreAnaesthesiaAssessment);
exports.savePac = (req, res, next) => saveForm(req, res, next, OTPreAnaesthesiaAssessment, 'ot.pac.updated', async ({ otCase }) => ({ readiness: await reconcileOtReadiness({ otCase, userId: req.user._id, autoApprove: true }) }));
exports.getAnesthesia = (req, res, next) => getForm(req, res, next, OTAnesthesiaRecord);
exports.saveAnesthesia = (req, res, next) => { try { validateClinicalPayload('anesthesia', req.body); } catch (error) { return next(error); } return saveForm(req, res, next, OTAnesthesiaRecord, 'ot.anesthesia.updated'); };
exports.getOperative = (req, res, next) => getForm(req, res, next, OTOperativeNote);
exports.saveOperative = (req, res, next) => { try { validateClinicalPayload('operative', req.body); } catch (error) { return next(error); } return saveForm(req, res, next, OTOperativeNote, 'ot.operative_note.updated'); };
exports.getRecovery = (req, res, next) => getForm(req, res, next, OTRecoveryRecord);
exports.saveRecovery = (req, res, next) => { try { validateClinicalPayload('recovery', req.body); } catch (error) { return next(error); } return saveForm(req, res, next, OTRecoveryRecord, 'ot.recovery.updated'); };
exports.getInventory = (req, res, next) => getForm(req, res, next, OTCaseInventoryUsage);
exports.saveInventory = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const record = await saveInventoryUsage({ otCase, payload: req.body, user: req.user });
    otCase.inventoryClosureStatus = record.status === 'Reconciled' ? 'Reconciled' : 'Pending';
    otCase.inventoryStatus = record.status;
    await otCase.save();
    await appendDomainEvent({ req, eventType: 'ot.inventory.updated', entityType: 'OTCaseInventoryUsage', entityId: record._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, revision: record.version, afterSummary: { status: record.status, totalCost: record.totalCost, totalPatientCharge: record.totalPatientCharge } });
    res.json({ success: true, message: record.status === 'Reconciled' ? 'OT inventory reconciled and billable usage posted' : 'OT inventory usage saved', data: record });
  } catch (error) { next(error); }
};

exports.getInventoryOptions = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const q = String(req.query.q || '').trim();
    const itemId = req.query.itemId;
    const locationId = req.query.locationId;
    const itemFilter = { hospital_id: otCase.hospitalId, is_active: { $ne: false }, deleted_at: { $exists: false } };
    if (q) itemFilter.$or = [
      { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
      { item_code: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
      { brand: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
    ];
    const [locations, items, lots] = await Promise.all([
      StoreLocation.find({ hospitalId: otCase.hospitalId, isActive: { $ne: false }, allowIssue: { $ne: false } }).select('code name type').sort({ type: 1, code: 1 }).lean(),
      StoreItem.find(itemFilter).select('item_code name item_type unit serial_tracking batch_tracking average_cost').sort({ name: 1 }).limit(50).lean(),
      itemId ? InventoryLot.find({
        hospitalId: otCase.hospitalId,
        itemId,
        qualityStatus: 'Accepted',
        ...(locationId ? { locationBalances: { $elemMatch: { locationId, onHand: { $gt: 0 } } } } : {})
      }).select('lotNumber serialNumber expiryDate unitCost totalOnHand totalReserved totalAvailable locationBalances').sort({ expiryDate: 1, createdAt: 1 }).limit(50).lean() : []
    ]);
    const shapedLots = lots.map((lot) => {
      const balance = locationId ? (lot.locationBalances || []).find((row) => String(row.locationId) === String(locationId)) : null;
      return {
        _id: lot._id, lotNumber: lot.lotNumber, serialNumber: lot.serialNumber, expiryDate: lot.expiryDate,
        unitCost: lot.unitCost, onHand: balance?.onHand ?? lot.totalOnHand, reserved: balance?.reserved ?? lot.totalReserved,
        available: balance?.available ?? lot.totalAvailable
      };
    });
    res.json({ success: true, data: { locations, items, lots: shapedLots } });
  } catch (error) { next(error); }
};

exports.createSpecimen = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const count = await OTSpecimen.countDocuments({ hospitalId: otCase.hospitalId, caseId: otCase._id });
    const specimen = await OTSpecimen.create({ ...req.body, hospitalId: otCase.hospitalId, caseId: otCase._id, admissionId: otCase.admissionId, patientId: otCase.patientId, specimenNumber: req.body.specimenNumber || `${otCase.requestNumber}/SP-${String(count + 1).padStart(2, '0')}`, collectedBy: req.user._id, collectedAt: req.body.collectedAt || operationNow() });
    const pathology = await ensurePathologyOrder({ otCase, specimen, labTestId: req.body.labTestId || req.body.pathologyLabTestId, user: req.user });
    await appendDomainEvent({ req, eventType: 'ot.specimen.created', entityType: 'OTSpecimen', entityId: specimen._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, afterSummary: { specimenNumber: specimen.specimenNumber, pathologyOrderId: pathology.labRequest?._id } });
    res.status(201).json({ success: true, data: pathology.specimen, pathologyOrder: pathology.labRequest, financialWarning: pathology.financialWarning });
  } catch (error) { next(error); }
};

exports.updateSpecimen = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const specimen = await OTSpecimen.findOne({ _id: req.params.specimenId, hospitalId: otCase.hospitalId, caseId: otCase._id });
    if (!specimen) return res.status(404).json({ error: 'OT specimen not found' });
    const action = String(req.body.action || '').toLowerCase();
    if (action === 'handover') { specimen.status = 'Handed Over'; specimen.handedOverBy = req.user._id; specimen.handedOverAt = req.body.handedOverAt || operationNow(); }
    else if (action === 'receive') { specimen.status = 'Received'; specimen.receivedBy = req.user._id; specimen.receivedAt = req.body.receivedAt || operationNow(); }
    else if (action === 'reject') { specimen.status = 'Rejected'; specimen.rejectionReason = String(req.body.rejectionReason || '').trim(); if (!specimen.rejectionReason) return res.status(400).json({ error: 'Rejection reason is required' }); }
    else return res.status(400).json({ error: 'Supported specimen actions are handover, receive and reject' });
    await specimen.save();
    await appendDomainEvent({ req, eventType: `ot.specimen.${action}`, entityType: 'OTSpecimen', entityId: specimen._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, afterSummary: { status: specimen.status, pathologyOrderId: specimen.pathologyOrderId } });
    res.json({ success: true, data: specimen });
  } catch (error) { next(error); }
};

exports.addAdditionalProcedure = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    if (!['In Progress', 'Recovery'].includes(canonicalStatus(otCase.status, otCase))) return res.status(409).json({ error: 'Additional OT procedures can only be recorded during or immediately after surgery' });
    const record = await addAdditionalProcedure({ otCase, payload: req.body, user: req.user });
    await appendDomainEvent({ req, eventType: 'ot.additional_procedure.added', entityType: 'OTAdditionalProcedure', entityId: record._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, afterSummary: { procedureCode: record.procedureCode, billingStatus: record.billingStatus } });
    res.status(201).json({ success: true, data: record });
  } catch (error) { next(error); }
};

exports.getFinancialReconciliation = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const data = await financialReconciliation(otCase);
    otCase.financialReconciliationStatus = data.status; otCase.financialReconciliationSummary = data; await otCase.save();
    res.json({ success: true, data });
  } catch (error) { next(error); }
};

exports.getCasePacket = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const manifest = await patientFileManifest.buildManifest(req, otCase.admissionId, {});
    res.json({ success: true, data: { caseId: String(otCase._id), requestNumber: otCase.requestNumber, admission: manifest.admission, documents: manifest.documents.filter((document) => String(document.relatedCaseId || '') === String(otCase._id) || ['admission', 'assessment', 'investigation', 'medication', 'discharge'].includes(document.category)) } });
  } catch (error) { next(error); }
};

exports.completeSurgeryLegacy = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    await OTOperativeNote.findOneAndUpdate(
      { hospitalId: otCase.hospitalId, caseId: otCase._id },
      { $set: { hospitalId: otCase.hospitalId, caseId: otCase._id, admissionId: otCase.admissionId, patientId: otCase.patientId, findings: req.body.findings, complications: req.body.complications, procedurePerformed: req.body.procedure_performed || otCase.procedureName, estimatedBloodLossMl: req.body.blood_loss_ml, postOpDiagnosis: req.body.post_op_diagnosis, postOpPlan: req.body.post_op_instructions, implants: req.body.implants || [], status: 'Completed', authoredBy: req.user._id, surgeryDate: operationNow() }, $inc: { version: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (otCase.status === 'In Progress') {
      req.params.action = 'recover';
      return exports.transitionCase(req, res, next);
    }
    res.json({ success: true, message: 'Operative note saved', data: otCase });
  } catch (error) { next(error); }
};
