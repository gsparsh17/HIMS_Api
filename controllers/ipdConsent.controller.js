const { operationNow } = require('../utils/operationTimeContext');
const IPDConsent = require('../models/IPDConsent');
const IPDAdmission = require('../models/IPDAdmission');
const Doctor = require('../models/Doctor');
const Hospital = require('../models/Hospital');
const DocumentSignature = require('../models/DocumentSignature');
const { version, templates } = require('../data/ipdConsentTemplates');
const { generateConsentPdf } = require('../services/consentPdf.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { appendDomainEvent } = require('../services/auditEvent.service');

const findTemplate = (id) => templates.find((template) => template.id === id);
const scopeKey = (body = {}, query = {}) => body.scopeKey || query.scopeKey || (body.relatedOTCaseId || query.relatedOTCaseId ? `ot:${body.relatedOTCaseId || query.relatedOTCaseId}` : body.relatedProcedureId || query.relatedProcedureId ? `procedure:${body.relatedProcedureId || query.relatedProcedureId}` : 'admission');
const objectId = (value) => value?._id || value || null;

function personName(person = {}) {
  return person.name || [person.salutation, person.first_name || person.firstName, person.middle_name || person.middleName, person.last_name || person.lastName]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function doctorName(doctor = {}) {
  const name = [doctor.firstName, doctor.lastName].filter(Boolean).join(' ').trim();
  if (!name) return '';
  return /^dr\.?\s/i.test(name) ? name : `Dr. ${name}`;
}

function indiaDateTimeParts(date = operationNow()) {
  const shifted = new Date(date.getTime() + (330 * 60 * 1000));
  return {
    date: shifted.toISOString().slice(0, 10),
    time: shifted.toISOString().slice(11, 16)
  };
}

function doctorDto(doctor) {
  if (!doctor) return null;
  return {
    _id: doctor._id,
    userId: objectId(doctor.user_id),
    name: doctorName(doctor),
    firstName: doctor.firstName,
    lastName: doctor.lastName,
    doctorId: doctor.doctorId,
    registrationNumber: doctor.licenseNumber,
    specialization: doctor.specialization,
    department: doctor.department ? {
      _id: objectId(doctor.department),
      name: doctor.department.name || doctor.department.departmentName
    } : null
  };
}

async function admissionFor(req, { populate = true } = {}) {
  const hospitalId = requireHospitalId(req);
  let query = IPDAdmission.findOne({ _id: req.params.admissionId, hospitalId });
  if (populate) {
    query = query
      .populate('patientId')
      .populate({ path: 'primaryDoctorId', populate: { path: 'department user_id', select: 'name departmentName email role' } })
      .populate({ path: 'secondaryDoctorIds', populate: { path: 'department user_id', select: 'name departmentName email role' } })
      .populate('wardId roomId bedId departmentId');
  }
  const admission = await query;
  if (!admission) throw Object.assign(new Error('IPD admission not found'), { statusCode: 404 });
  return admission;
}

async function viewerDoctor(req, hospitalId) {
  if (String(req.user?.role || '').toLowerCase() !== 'doctor') return null;
  const alternatives = [{ user_id: req.user._id }];
  if (req.user.email) alternatives.push({ email: String(req.user.email).toLowerCase() });
  return Doctor.findOne({ hospitalId, $or: alternatives })
    .populate('department', 'name departmentName')
    .populate('user_id', 'name email role');
}

async function consentContext(req, admission) {
  const hospitalId = objectId(admission.hospitalId);
  const [doctors, loggedInDoctor, hospital] = await Promise.all([
    Doctor.find({ hospitalId })
      .select('user_id doctorId firstName lastName licenseNumber specialization department')
      .populate('department', 'name departmentName')
      .populate('user_id', 'name email role')
      .sort({ firstName: 1, lastName: 1 })
      .lean(),
    viewerDoctor(req, hospitalId),
    Hospital.findById(hospitalId).select('hospitalName hospitalID registryNo address city state phone email').lean()
  ]);

  const role = String(req.user?.role || '').toLowerCase();
  const responsibleDoctor = role === 'doctor'
    ? loggedInDoctor
    : (admission.primaryDoctorId || loggedInDoctor);

  return {
    viewer: {
      _id: req.user?._id,
      name: req.user?.name,
      email: req.user?.email,
      role,
      doctorSelectionLocked: role === 'doctor'
    },
    responsibleDoctor: doctorDto(responsibleDoctor),
    doctors: doctors.map(doctorDto),
    admission: {
      _id: admission._id,
      admissionNumber: admission.admissionNumber || admission.shipNumber,
      shipNumber: admission.shipNumber,
      status: admission.status,
      admissionDate: admission.admissionDate,
      dischargeDate: admission.dischargeDate,
      ward: admission.wardId ? { _id: objectId(admission.wardId), name: admission.wardId.name || admission.wardId.wardName } : null,
      room: admission.roomId ? { _id: objectId(admission.roomId), name: admission.roomId.roomNumber || admission.roomId.room_number || admission.roomId.name } : null,
      bed: admission.bedId ? { _id: objectId(admission.bedId), name: admission.bedId.bedNumber || admission.bedId.bed_number || admission.bedId.name } : null,
      department: admission.departmentId ? { _id: objectId(admission.departmentId), name: admission.departmentId.name || admission.departmentId.departmentName } : null,
      primaryDoctor: doctorDto(admission.primaryDoctorId)
    },
    patient: admission.patientId ? {
      _id: objectId(admission.patientId),
      name: personName(admission.patientId),
      uhid: admission.patientId.uhid || admission.patientId.patient_id || admission.patientId.patientId,
      age: admission.patientId.age,
      gender: admission.patientId.gender,
      phone: admission.patientId.phone || admission.patientId.mobile,
      address: admission.patientId.address || admission.patientId.address_line || admission.patientId.full_address || '',
      guardianName: admission.patientId.guardianName || admission.patientId.father_name || admission.patientId.husband_name || '',
      dob: admission.patientId.dob
    } : null,
    hospital
  };
}


function consentSnapshots(context = {}, responses = {}) {
  const patient = context.patient || {};
  const admission = context.admission || {};
  const hospital = context.hospital || {};
  return {
    patientSnapshot: {
      name: patient.name,
      uhid: patient.uhid,
      age: patient.age,
      gender: patient.gender,
      guardianName: responses.guardianName || responses.requestingPersonParentSpouse || patient.guardianName || '',
      address: responses.address || patient.address || '',
      phone: patient.phone || ''
    },
    admissionSnapshot: {
      admissionNumber: admission.admissionNumber || admission.shipNumber,
      admissionDate: admission.admissionDate,
      ward: admission.ward?.name || '',
      room: admission.room?.name || '',
      bed: admission.bed?.name || '',
      department: admission.department?.name || '',
      diagnosis: responses.diagnosis || responses.clinicalReason || '',
      consultantName: admission.primaryDoctor?.name || responses.doctorName || ''
    },
    hospitalSnapshot: {
      hospitalName: hospital.hospitalName,
      registryNo: hospital.registryNo || hospital.hospitalID,
      address: hospital.address,
      city: hospital.city,
      state: hospital.state,
      phone: hospital.phone,
      email: hospital.email
    }
  };
}

async function normalizedResponses(req, admission, rawResponses = {}) {
  const responses = { ...(rawResponses && typeof rawResponses === 'object' ? rawResponses : {}) };
  const hospitalId = objectId(admission.hospitalId);
  const role = String(req.user?.role || '').toLowerCase();
  let selectedDoctor = null;

  if (role === 'doctor') {
    selectedDoctor = await viewerDoctor(req, hospitalId);
    if (!selectedDoctor) {
      throw Object.assign(new Error('Your doctor login is not linked to a doctor profile in this hospital'), { statusCode: 409 });
    }
  } else if (responses.doctorId) {
    selectedDoctor = await Doctor.findOne({ _id: responses.doctorId, hospitalId }).populate('department', 'name departmentName');
    if (!selectedDoctor) throw Object.assign(new Error('Selected responsible doctor was not found in this hospital'), { statusCode: 400 });
  } else {
    selectedDoctor = admission.primaryDoctorId?._id
      ? admission.primaryDoctorId
      : await Doctor.findOne({ _id: admission.primaryDoctorId, hospitalId }).populate('department', 'name departmentName');
  }

  if (!selectedDoctor) throw Object.assign(new Error('Select a responsible doctor before completing this consent'), { statusCode: 400 });

  const patient = admission.patientId;
  const dateTime = indiaDateTimeParts();
  responses.patientOrRepresentativeName = String(responses.patientOrRepresentativeName || personName(patient) || '').trim();
  if (!responses.relationship && responses.patientOrRepresentativeName === personName(patient)) responses.relationship = 'Self';
  responses.doctorId = objectId(selectedDoctor);
  responses.doctorUserId = objectId(selectedDoctor.user_id);
  responses.doctorName = doctorName(selectedDoctor);
  responses.doctorRegistrationNumber = selectedDoctor.licenseNumber || '';
  responses.doctorSpecialization = selectedDoctor.specialization || '';
  responses.doctorSelectionSource = role === 'doctor' ? 'logged_in_doctor' : 'selected_responsible_doctor';
  responses.signedDate = responses.signedDate || dateTime.date;
  responses.signedTime = responses.signedTime || dateTime.time;
  responses.doctorSignedDate = responses.doctorSignedDate || dateTime.date;
  responses.doctorSignedTime = responses.doctorSignedTime || dateTime.time;

  // Signature and seal images are stored as controlled profile/patient assets and
  // placed through the signed-print editor. Never accept arbitrary URL/data-image
  // fields in the clinical response payload.
  delete responses.patientSignatureUrl;
  delete responses.patientSignature;
  delete responses.doctorSignatureUrl;
  delete responses.doctorSignature;
  delete responses.doctorSealUrl;

  return responses;
}

exports.listTemplates = async (_req, res) => res.json({ success: true, version, data: templates });

exports.listAdmissionConsents = async (req, res, next) => {
  try {
    const admission = await admissionFor(req);
    const filter = { hospitalId: admission.hospitalId, admissionId: admission._id };
    if (req.query.relatedOTCaseId) filter.relatedOTCaseId = req.query.relatedOTCaseId;
    const [records, context] = await Promise.all([
      IPDConsent.find(filter).sort({ updatedAt: -1 }).populate('finalDocumentSignatureId', 'placements signatoryRole signedAt verificationCode status'),
      consentContext(req, admission)
    ]);
    res.json({
      success: true,
      version,
      context,
      data: templates.map((template) => ({
        template,
        consents: records.filter((record) => record.templateId === template.id),
        consent: records.find((record) => record.templateId === template.id && record.scopeKey === 'admission') || null
      }))
    });
  } catch (error) { next(error); }
};

exports.getConsent = async (req, res, next) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const admission = await admissionFor(req);
    const [consent, context] = await Promise.all([
      IPDConsent.findOne({ hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: scopeKey({}, req.query) }).populate('finalDocumentSignatureId', 'placements signatoryRole signedAt verificationCode status'),
      consentContext(req, admission)
    ]);
    res.json({ success: true, data: { template, consent, context } });
  } catch (error) { next(error); }
};

exports.saveConsent = async (req, res, next) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const admission = await admissionFor(req);
    const responses = await normalizedResponses(req, admission, req.body.responses);
    const requestedStatus = ['Completed', 'Signed'].includes(req.body.status) ? req.body.status : 'Draft';
    const snapshotContext = await consentContext(req, admission);
    const snapshots = consentSnapshots(snapshotContext, responses);

    if (requestedStatus !== 'Draft') {
      const missing = (template.fields || []).filter((field) => field.required).filter((field) => {
        const value = responses[field.key];
        return value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length);
      });
      if (missing.length) return res.status(400).json({ error: `Complete required fields: ${missing.map((field) => field.label).join(', ')}` });
    }

    const key = scopeKey(req.body);
    const existing = await IPDConsent.findOne({ hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: key });
    let finalDocumentSignatureId = existing?.finalDocumentSignatureId;

    if (req.body.finalDocumentSignatureId) {
      if (!existing) return res.status(409).json({ error: 'Save the consent draft before applying final signature placements' });
      const signature = await DocumentSignature.findOne({
        _id: req.body.finalDocumentSignatureId,
        hospitalId: admission.hospitalId,
        sourceModel: 'IPDConsent',
        sourceId: existing._id,
        status: 'signed'
      });
      if (!signature) return res.status(400).json({ error: 'The supplied signed-print record does not belong to this consent' });
      finalDocumentSignatureId = signature._id;
    }

    if (requestedStatus === 'Signed' && !finalDocumentSignatureId) {
      return res.status(400).json({ error: 'Open Preview & Place Marks and complete signed printing before marking this consent as Signed' });
    }

    const responseAssetId = responses.patientSignatureAssetId;
    const responseSignatures = responseAssetId ? [{
      role: 'patient',
      name: responses.patientOrRepresentativeName || personName(admission.patientId),
      relation: responses.relationship || '',
      signedAt: responses.patientSignedAt || operationNow(),
      method: responses.patientSignatureMethod === 'typed_acknowledgement' ? 'typed' : (responses.patientSignatureMethod || 'drawn'),
      assetId: responseAssetId,
      assetModel: 'PatientIdentityAsset'
    }] : [];

    const patientId = objectId(admission.patientId);
    const update = {
      hospitalId: admission.hospitalId,
      patientId,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      rendererId: template.rendererId || 'reference-consent',
      formRevision: Number(existing?.formRevision || 0) + 1,
      scopeKey: key,
      relatedOTCaseId: req.body.relatedOTCaseId,
      relatedProcedureId: req.body.relatedProcedureId,
      status: requestedStatus,
      responses,
      signatures: Array.isArray(req.body.signatures) && req.body.signatures.length
        ? req.body.signatures
        : (responseSignatures.length ? responseSignatures : existing?.signatures || []),
      notes: req.body.notes || '',
      finalDocumentSignatureId,
      ...snapshots,
      printSnapshot: requestedStatus === 'Draft' ? existing?.printSnapshot || null : {
        templateId: template.id,
        templateName: template.name,
        templateVersion: template.version,
        rendererId: template.rendererId || 'reference-consent',
        responses,
        ...snapshots,
        finalizedAt: operationNow()
      },
      updatedBy: req.user._id,
      ...(requestedStatus !== 'Draft' ? {
        completedAt: operationNow(),
        completedBy: req.user._id,
        finalizedAt: operationNow(),
        finalizedBy: req.user._id
      } : {})
    };

    const consent = await IPDConsent.findOneAndUpdate(
      { hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: key },
      { $set: update, $setOnInsert: { admissionId: admission._id, createdBy: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );

    await appendDomainEvent({
      req,
      eventType: requestedStatus === 'Draft' ? 'consent.draft_saved' : requestedStatus === 'Signed' ? 'consent.signed' : 'consent.completed',
      entityType: 'IPDConsent',
      entityId: consent._id,
      hospitalId: admission.hospitalId,
      patientId,
      encounterId: admission._id,
      revision: consent.formRevision,
      afterSummary: { templateId: template.id, status: requestedStatus, scopeKey: key, finalDocumentSignatureId }
    });

    res.json({ success: true, message: requestedStatus === 'Draft' ? 'Consent draft saved' : requestedStatus === 'Signed' ? 'Consent signed and completed' : 'Consent completed', data: consent });
  } catch (error) { next(error); }
};

exports.printConsent = async (req, res, next) => {
  try {
    const template = findTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Consent template not found' });
    const admission = await admissionFor(req);
    const consent = await IPDConsent.findOne({ hospitalId: admission.hospitalId, admissionId: admission._id, templateId: template.id, scopeKey: scopeKey({}, req.query) });
    if (!consent) return res.status(404).json({ error: 'Consent form has not been saved' });
    const hospital = await Hospital.findById(admission.hospitalId);
    let documentSignature = null;
    if (req.query.signatureId) {
      documentSignature = await DocumentSignature.findOne({
        _id: req.query.signatureId,
        hospitalId: admission.hospitalId,
        sourceModel: 'IPDConsent',
        sourceId: consent._id,
        status: 'signed'
      }).lean();
      if (!documentSignature) return res.status(404).json({ error: 'Signed consent placement record not found' });
    }
    await generateConsentPdf({ consent, template, admission, hospital, documentSignature, res });
  } catch (error) { if (!res.headersSent) next(error); }
};
