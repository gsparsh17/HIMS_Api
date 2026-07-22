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
const IPDAdmission = require('../models/IPDAdmission');
const Room = require('../models/Room');
const { requireHospitalId } = require('../services/tenantScope.service');
const { transitionDocument, transitionError } = require('../services/workflowTransition.service');
const { appendDomainEvent } = require('../services/auditEvent.service');
const patientFileManifest = require('../services/patientFileManifest.service');

const ACTIVE_SCHEDULE_STATUSES = ['Scheduled', 'In Progress'];

const DEFAULT_READINESS_ITEMS = [
  ['identity_verified', 'Patient identity verified', 'Patient'],
  ['procedure_confirmed', 'Procedure and site confirmed', 'Patient'],
  ['general_consent', 'General consent completed', 'Consent'],
  ['procedure_consent', 'Procedure/surgery consent completed', 'Consent'],
  ['anaesthesia_consent', 'Anaesthesia consent completed', 'Consent'],
  ['pac_complete', 'Pre-anaesthesia assessment completed', 'Anaesthesia'],
  ['npo_confirmed', 'NPO/last oral intake confirmed', 'Clinical'],
  ['allergy_reviewed', 'Allergies reviewed', 'Clinical'],
  ['investigations_reviewed', 'Required investigations reviewed', 'Investigation'],
  ['blood_ready', 'Blood requirement and availability confirmed', 'Blood'],
  ['site_marked', 'Surgical site marked where applicable', 'Patient'],
  ['equipment_ready', 'Equipment and implants ready', 'Store'],
  ['financial_clearance', 'Financial/payer clearance completed or exception approved', 'Billing']
].map(([key, label, category]) => ({ key, label, category, required: true, status: 'Pending' }));

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

async function evaluateReadiness(checklist) {
  const required = checklist.items.filter((item) => item.required);
  const pending = required.filter((item) => !['Complete', 'Not Applicable', 'Bypassed'].includes(item.status));
  const bypassed = required.some((item) => item.status === 'Bypassed');
  checklist.overallStatus = pending.length ? 'Pending' : bypassed ? 'Ready With Bypass' : 'Ready';
  checklist.evaluatedAt = new Date();
  checklist.version = Number(checklist.version || 0) + 1;
  return checklist;
}

async function getOrCreateReadiness(otCase, userId) {
  let checklist = await OTReadinessChecklist.findOne({ hospitalId: otCase.hospitalId, caseId: otCase._id });
  if (!checklist) {
    checklist = await OTReadinessChecklist.create({
      hospitalId: otCase.hospitalId,
      caseId: otCase._id,
      admissionId: otCase.admissionId,
      patientId: otCase.patientId,
      items: DEFAULT_READINESS_ITEMS,
      evaluatedBy: userId
    });
  }
  return checklist;
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
    if (!admission || ['Discharged', 'Cancelled'].includes(admission.status)) return res.status(404).json({ error: 'Active IPD admission not found' });
    const patientId = req.body.patientId || admission.patientId;
    if (String(patientId) !== String(admission.patientId)) return res.status(400).json({ error: 'Patient does not match admission' });
    const otCase = await OTRequest.create({
      ...req.body,
      hospitalId,
      encounterType: 'IPD',
      encounterId: admission._id,
      admissionId: admission._id,
      patientId,
      doctorId: req.body.doctorId || admission.primaryDoctorId,
      procedureCode: req.body.procedureCode || req.body.procedureName,
      procedureName: req.body.procedureName,
      status: 'Readiness Pending',
      readinessStatus: 'Pending',
      paymentStatus: req.body.paymentStatus || 'Pending',
      total_cost: Number(req.body.total_cost || req.body.estimated_cost || 0),
      estimated_cost: Number(req.body.estimated_cost || 0),
      createdBy: req.user._id
    });
    await getOrCreateReadiness(otCase, req.user._id);
    await getOrCreateSafety(otCase);
    await appendDomainEvent({ req, eventType: 'ot.case.requested', entityType: 'OTRequest', entityId: otCase._id, hospitalId, patientId, encounterId: admission._id, afterSummary: { requestNumber: otCase.requestNumber, procedureName: otCase.procedureName, status: otCase.status } });
    const populated = await casePopulate(OTRequest.findById(otCase._id));
    res.status(201).json({ success: true, message: 'OT case created and readiness workflow started', data: populated });
  } catch (error) { next(error); }
};

exports.listCases = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const filter = { hospitalId };
    for (const field of ['status', 'paymentStatus', 'admissionId', 'patientId', 'doctorId', 'urgency', 'otRoomId']) {
      if (req.query[field]) filter[field] = req.query[field];
    }
    if (req.query.startDate || req.query.endDate) {
      filter.requestedDate = {};
      if (req.query.startDate) filter.requestedDate.$gte = new Date(req.query.startDate);
      if (req.query.endDate) filter.requestedDate.$lte = new Date(req.query.endDate);
    }
    const [data, total] = await Promise.all([
      casePopulate(OTRequest.find(filter)).sort({ scheduledStart: 1, requestedDate: -1 }).skip((page - 1) * limit).limit(limit),
      OTRequest.countDocuments(filter)
    ]);
    res.json({ success: true, data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) { next(error); }
};

exports.getCase = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const otCase = await casePopulate(OTRequest.findOne({ _id: req.params.id, hospitalId }));
    if (!otCase) return res.status(404).json({ error: 'OT case not found' });
    res.json({ success: true, data: otCase });
  } catch (error) { next(error); }
};

exports.getWorkspace = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const filter = { hospitalId: otCase.hospitalId, caseId: otCase._id };
    const [readiness, safety, pac, anesthesia, operative, recovery, inventory, specimens, schedule] = await Promise.all([
      getOrCreateReadiness(otCase, req.user._id), getOrCreateSafety(otCase),
      OTPreAnaesthesiaAssessment.findOne(filter), OTAnesthesiaRecord.findOne(filter), OTOperativeNote.findOne(filter),
      OTRecoveryRecord.findOne(filter), OTCaseInventoryUsage.findOne(filter).populate('lines.itemId lines.lotId'),
      OTSpecimen.find(filter).sort({ createdAt: 1 }), OTSchedule.findOne({ hospitalId: otCase.hospitalId, requestId: otCase._id })
    ]);
    const populated = await casePopulate(OTRequest.findById(otCase._id));
    res.json({ success: true, data: { case: populated, readiness, safety, pac, anesthesia, operative, recovery, inventory, specimens, schedule } });
  } catch (error) { next(error); }
};

exports.getReadiness = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const checklist = await getOrCreateReadiness(otCase, req.user._id);
    res.json({ success: true, data: checklist });
  } catch (error) { next(error); }
};

exports.updateReadiness = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const checklist = await getOrCreateReadiness(otCase, req.user._id);
    const updates = new Map((req.body.items || []).map((item) => [item.key, item]));
    checklist.items.forEach((item) => {
      const update = updates.get(item.key);
      if (!update) return;
      if (update.status === 'Bypassed' && !req.body.bypassApproved) throw transitionError(`Bypass approval is required for ${item.label}`, 403);
      item.status = update.status || item.status;
      item.value = update.value;
      item.notes = update.notes;
      item.completedBy = req.user._id;
      item.completedAt = ['Complete', 'Not Applicable', 'Bypassed'].includes(item.status) ? new Date() : undefined;
      item.bypassReason = update.bypassReason;
      item.bypassApprovedBy = item.status === 'Bypassed' ? req.user._id : undefined;
    });
    checklist.evaluatedBy = req.user._id;
    await evaluateReadiness(checklist);
    await checklist.save();
    otCase.readinessStatus = checklist.overallStatus;
    if (checklist.overallStatus !== 'Pending' && otCase.status === 'Readiness Pending') otCase.status = 'Approved';
    await otCase.save();
    await appendDomainEvent({ req, eventType: 'ot.case.readiness_updated', entityType: 'OTReadinessChecklist', entityId: checklist._id, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, revision: checklist.version, afterSummary: { overallStatus: checklist.overallStatus } });
    res.json({ success: true, message: `Readiness is ${checklist.overallStatus}`, data: checklist, caseStatus: otCase.status });
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
    const section = checklist[sectionName];
    const updates = new Map((req.body.items || []).map((item) => [item.key, item]));
    section.items.forEach((item) => {
      const update = updates.get(item.key);
      if (!update) return;
      item.response = update.response;
      item.notes = update.notes;
      item.completedBy = req.user._id;
      item.completedAt = new Date();
    });
    const incomplete = section.items.filter((item) => !['Yes', 'Not Applicable'].includes(item.response));
    if (req.body.bypass) {
      section.status = 'Bypassed';
      section.bypassReason = req.body.bypassReason;
      section.bypassApprovedBy = req.user._id;
    } else {
      section.status = incomplete.length ? 'Pending' : 'Completed';
    }
    section.attestedBy = req.user._id;
    section.attestedAt = new Date();
    checklist.version = Number(checklist.version || 0) + 1;
    await checklist.save();
    res.json({ success: true, data: checklist });
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
      if (!['Approved', 'Payment Received', 'Scheduled', 'Postponed'].includes(otCase.status)) throw transitionError(`Case cannot be scheduled while status is ${otCase.status}`);
      if (otCase.readinessStatus === 'Pending' && otCase.urgency !== 'Emergency' && !otCase.emergencyOverride?.enabled) throw transitionError('OT readiness is incomplete');
      if (booleanEnv('OT_REQUIRE_PAYMENT_BEFORE_SCHEDULE', false) && !['Completed', 'Not Required'].includes(otCase.paymentStatus) && !otCase.emergencyOverride?.enabled) throw transitionError('Payment/payer clearance is required before scheduling');
      const scheduledStart = parseDateTime(req.body.scheduledStart || req.body.scheduledDate, req.body.scheduledTime);
      if (!scheduledStart || Number.isNaN(scheduledStart.getTime())) throw Object.assign(new Error('Valid schedule start is required'), { statusCode: 400 });
      const duration = Number(req.body.durationMinutes || req.body.estimated_duration_minutes || otCase.estimated_duration_minutes || 60);
      const scheduledEnd = req.body.scheduledEnd ? new Date(req.body.scheduledEnd) : new Date(scheduledStart.getTime() + duration * 60000);
      if (Number.isNaN(scheduledEnd.getTime()) || scheduledEnd <= scheduledStart) throw Object.assign(new Error('Valid schedule end is required'), { statusCode: 400 });
      const roomId = req.body.otRoomId || otCase.otRoomId;
      if (!roomId) throw Object.assign(new Error('OT room is required'), { statusCode: 400 });
      const room = await Room.findById(roomId).session(session);
      if (!room || !/operation/i.test(room.type || '')) throw Object.assign(new Error('Valid operation theatre room not found'), { statusCode: 404 });
      const conflict = await OTSchedule.findOne({
        hospitalId,
        otRoomId: roomId,
        requestId: { $ne: otCase._id },
        status: { $in: ACTIVE_SCHEDULE_STATUSES },
        scheduledStart: { $lt: scheduledEnd },
        scheduledEnd: { $gt: scheduledStart }
      }).session(session);
      if (conflict) throw transitionError('The selected theatre already has an overlapping active case', 409, { conflictId: conflict._id });
      const setupBufferMinutes = Number(req.body.setupBufferMinutes ?? otCase.setupBufferMinutes ?? 15);
      const cleaningBufferMinutes = Number(req.body.cleaningBufferMinutes ?? otCase.cleaningBufferMinutes ?? 20);
      const teamSnapshot = req.body.teamSnapshot || [];
      const schedule = await OTSchedule.findOneAndUpdate(
        { hospitalId, requestId: otCase._id },
        { $set: { hospitalId, otRoomId: roomId, requestId: otCase._id, scheduledDate: scheduledStart, startTime: scheduledStart.toTimeString().slice(0, 5), endTime: scheduledEnd.toTimeString().slice(0, 5), scheduledStart, scheduledEnd, duration_minutes: duration, setupBufferMinutes, cleaningBufferMinutes, conflictKey: `${roomId}:${scheduledStart.toISOString()}`, status: 'Scheduled', notes: req.body.notes, teamSnapshot, assignedBy: req.user._id }, $inc: { version: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );
      Object.assign(otCase, {
        otRoomId: roomId,
        scheduledDate: scheduledStart,
        scheduledTime: schedule.startTime,
        scheduledStart,
        scheduledEnd,
        estimated_duration_minutes: duration,
        setupBufferMinutes,
        cleaningBufferMinutes,
        primarySurgeonId: req.body.primarySurgeonId || otCase.primarySurgeonId,
        assistantSurgeonId: req.body.assistantSurgeonId || otCase.assistantSurgeonId,
        anesthetistId: req.body.anesthetistId || otCase.anesthetistId,
        scrubNurseId: req.body.scrubNurseId || otCase.scrubNurseId,
        circulatingNurseId: req.body.circulatingNurseId || otCase.circulatingNurseId,
        otStaffId: req.body.otStaffId || otCase.otStaffId,
        status: 'Scheduled',
        version: Number(otCase.version || 0) + 1
      });
      await otCase.save({ session });
      await appendDomainEvent({ req, eventType: 'ot.case.scheduled', entityType: 'OTRequest', entityId: otCase._id, hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, revision: otCase.version, afterSummary: { scheduledStart, scheduledEnd, roomId }, session });
      result = { otCase, schedule };
    });
    res.json({ success: true, message: 'OT case scheduled', data: result.otCase, schedule: result.schedule });
  } catch (error) { next(error); } finally { if (session) await session.endSession(); }
};

const transitions = {
  approve: { from: ['Requested', 'Readiness Pending', 'Payment Received'], to: 'Approved', eventType: 'ot.case.approved', guard: (doc) => doc.readinessStatus !== 'Pending' || doc.urgency === 'Emergency' || doc.emergencyOverride?.enabled, update: (_doc, req) => ({ approvedBy: req.user._id, approvedAt: new Date() }) },
  receive: { from: ['Scheduled'], to: 'Patient Received', eventType: 'ot.case.patient_received', guard: (doc) => doc.readinessStatus !== 'Pending' || doc.emergencyOverride?.enabled, update: { patientReceivedAt: new Date() } },
  start: { from: ['Patient Received', 'Scheduled'], to: 'In Progress', eventType: 'ot.case.started', update: { startedAt: new Date() } },
  recover: { from: ['In Progress'], to: 'Recovery', eventType: 'ot.case.recovery_started', update: { recoveryStartedAt: new Date(), completedAt: new Date() } },
  transfer: { from: ['Recovery'], to: 'Transferred', eventType: 'ot.case.transferred', update: { transferredAt: new Date(), transferred_to_ward: true } },
  close: { from: ['Transferred', 'Completed'], to: 'Closed', eventType: 'ot.case.closed', guard: async (doc) => {
    const [operative, anesthesia, recovery, inventory] = await Promise.all([
      OTOperativeNote.findOne({ hospitalId: doc.hospitalId, caseId: doc._id }),
      OTAnesthesiaRecord.findOne({ hospitalId: doc.hospitalId, caseId: doc._id }),
      OTRecoveryRecord.findOne({ hospitalId: doc.hospitalId, caseId: doc._id }),
      OTCaseInventoryUsage.findOne({ hospitalId: doc.hospitalId, caseId: doc._id })
    ]);
    if (!operative || !['Completed', 'Signed'].includes(operative.status)) return 'Operative note is incomplete';
    if (!anesthesia || !['Completed', 'Signed'].includes(anesthesia.status)) return 'Anaesthesia record is incomplete';
    if (!recovery || !['Transferred', 'Signed'].includes(recovery.status)) return 'Recovery/transfer record is incomplete';
    if (inventory && inventory.status !== 'Reconciled') return 'OT inventory usage is not reconciled';
    return true;
  }, update: { closedAt: new Date(), clinicalClosureStatus: 'Closed', inventoryClosureStatus: 'Reconciled' } },
  postpone: { from: ['Approved', 'Scheduled', 'Patient Received'], to: 'Postponed', eventType: 'ot.case.postponed', update: { postponedAt: new Date() } },
  cancel: { from: ['Requested', 'Readiness Pending', 'Payment Pending', 'Payment Received', 'Approved', 'Scheduled', 'Patient Received', 'Postponed'], to: 'Cancelled', eventType: 'ot.case.cancelled', update: (_doc, req) => ({ cancelledAt: new Date(), cancelledBy: req.user._id }) }
};

exports.transitionCase = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const action = req.params.action || req.body.action;
    const updated = await transitionDocument({ document: otCase, action, definitions: transitions, req, hospitalId: otCase.hospitalId, patientId: otCase.patientId, encounterId: otCase.admissionId, reasonCode: req.body.reasonCode, comments: req.body.comments || req.body.reason, extraUpdate: action === 'cancel' ? { cancellationReason: req.body.reason } : action === 'postpone' ? { postponementReason: req.body.reason } : {} });
    if (['cancel', 'postpone'].includes(action)) await OTSchedule.findOneAndUpdate({ hospitalId: otCase.hospitalId, requestId: otCase._id }, { $set: { status: action === 'cancel' ? 'Cancelled' : 'Rescheduled' } });
    if (action === 'start') await OTSchedule.findOneAndUpdate({ hospitalId: otCase.hospitalId, requestId: otCase._id }, { $set: { status: 'In Progress' } });
    if (['recover', 'close'].includes(action)) await OTSchedule.findOneAndUpdate({ hospitalId: otCase.hospitalId, requestId: otCase._id }, { $set: { status: 'Completed' } });
    res.json({ success: true, message: `OT case ${action} completed`, data: updated });
  } catch (error) { next(error); }
};

exports.legacyStatusTransition = async (req, res, next) => {
  const mapping = { Approved: 'approve', Scheduled: null, 'Patient Received': 'receive', 'In Progress': 'start', Recovery: 'recover', Completed: 'recover', Transferred: 'transfer', Closed: 'close', Postponed: 'postpone', Cancelled: 'cancel' };
  const action = mapping[req.body.status];
  if (!action) return res.status(400).json({ error: 'Use the schedule endpoint for Scheduled status' });
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

async function saveForm(req, res, next, Model, eventType) {
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
    res.json({ success: true, message: 'OT clinical record saved', data: record });
  } catch (error) { next(error); }
}

exports.getPac = (req, res, next) => getForm(req, res, next, OTPreAnaesthesiaAssessment);
exports.savePac = (req, res, next) => saveForm(req, res, next, OTPreAnaesthesiaAssessment, 'ot.pac.updated');
exports.getAnesthesia = (req, res, next) => getForm(req, res, next, OTAnesthesiaRecord);
exports.saveAnesthesia = (req, res, next) => saveForm(req, res, next, OTAnesthesiaRecord, 'ot.anesthesia.updated');
exports.getOperative = (req, res, next) => getForm(req, res, next, OTOperativeNote);
exports.saveOperative = (req, res, next) => saveForm(req, res, next, OTOperativeNote, 'ot.operative_note.updated');
exports.getRecovery = (req, res, next) => getForm(req, res, next, OTRecoveryRecord);
exports.saveRecovery = (req, res, next) => saveForm(req, res, next, OTRecoveryRecord, 'ot.recovery.updated');
exports.getInventory = (req, res, next) => getForm(req, res, next, OTCaseInventoryUsage);
exports.saveInventory = (req, res, next) => saveForm(req, res, next, OTCaseInventoryUsage, 'ot.inventory.updated');

exports.createSpecimen = async (req, res, next) => {
  try {
    const otCase = await findCase(req, req.params.id);
    const count = await OTSpecimen.countDocuments({ hospitalId: otCase.hospitalId, caseId: otCase._id });
    const specimen = await OTSpecimen.create({ ...req.body, hospitalId: otCase.hospitalId, caseId: otCase._id, admissionId: otCase.admissionId, patientId: otCase.patientId, specimenNumber: req.body.specimenNumber || `${otCase.requestNumber}/SP-${String(count + 1).padStart(2, '0')}`, collectedBy: req.user._id, collectedAt: req.body.collectedAt || new Date() });
    res.status(201).json({ success: true, data: specimen });
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
      { $set: { hospitalId: otCase.hospitalId, caseId: otCase._id, admissionId: otCase.admissionId, patientId: otCase.patientId, findings: req.body.findings, complications: req.body.complications, procedurePerformed: req.body.procedure_performed || otCase.procedureName, estimatedBloodLossMl: req.body.blood_loss_ml, postOpDiagnosis: req.body.post_op_diagnosis, postOpPlan: req.body.post_op_instructions, implants: req.body.implants || [], status: 'Completed', authoredBy: req.user._id, surgeryDate: new Date() }, $inc: { version: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (otCase.status === 'In Progress') {
      req.params.action = 'recover';
      return exports.transitionCase(req, res, next);
    }
    res.json({ success: true, message: 'Operative note saved', data: otCase });
  } catch (error) { next(error); }
};
