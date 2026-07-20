const LabRequest = require('../models/LabRequest');
const LabTest = require('../models/LabTest');
const LabStaff = require('../models/LabStaff');
const IPDAdmission = require('../models/IPDAdmission');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const LabReport = require('../models/LabReport');
const Hospital = require('../models/Hospital');
const {
  catalogVersion,
  listTemplates,
  getTemplate,
  matchTemplate,
  matchTemplateDetailed
} = require('../services/labReportTemplate.service');
const { generateLabReportPdf } = require('../services/clinicalPdf.service');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});


const cleanText = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
};

const toObservation = (item = {}) => ({
  analyteCode: cleanText(item.analyteCode || item.analyte_code),
  name: cleanText(item.name || item.analyteName || item.analyte_name, 'Investigation'),
  resultType: item.resultType === 'numeric' ? 'numeric' : 'text',
  resultNumeric: cleanText(item.resultNumeric || item.result_numeric),
  resultText: cleanText(item.resultText || item.result_text || item.result),
  comparator: cleanText(item.comparator || item.resultComparator),
  printedFlag: cleanText(item.printedFlag || item.printed_flag || item.flag),
  derivedFlag: cleanText(item.derivedFlag || item.derived_flag),
  referenceLow: cleanText(item.referenceLow || item.reference_low),
  referenceHigh: cleanText(item.referenceHigh || item.reference_high),
  referenceText: cleanText(item.referenceText || item.reference_text || item.referenceValue),
  unit: cleanText(item.unit),
  method: cleanText(item.method),
  instrument: cleanText(item.instrument),
  comments: cleanText(item.comments)
});

const toNarrativeSection = (section = {}, index = 0) => ({
  key: cleanText(section.key, `section-${index + 1}`),
  label: cleanText(section.label || section.title, `Comments ${index + 1}`),
  text: cleanText(section.text ?? section.defaultText ?? section.default_text),
  isDefault: Boolean(section.isDefault || section.is_default)
});

const hasEnteredResult = (observation) => Boolean(
  cleanText(observation.resultNumeric) || cleanText(observation.resultText)
);

const parseNumeric = (value) => {
  const normalized = cleanText(value).replace(/,/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
};

const deriveSimpleFlag = (observation) => {
  if (cleanText(observation.derivedFlag)) return observation.derivedFlag;
  const value = parseNumeric(observation.resultNumeric || observation.resultText);
  const reference = cleanText(observation.referenceText);
  if (value === null || !reference) return '';

  const range = reference.match(/^\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:-|–|—|to)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*$/i);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (value < low) return 'Low';
    if (value > high) return 'High';
    return 'Normal';
  }

  const oneSided = reference.match(/^\s*(<=|>=|<|>|≤|≥)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*$/);
  if (!oneSided) return '';
  const operator = oneSided[1];
  const boundary = Number(oneSided[2]);
  const passes = operator === '<' ? value < boundary
    : operator === '<=' || operator === '≤' ? value <= boundary
      : operator === '>' ? value > boundary
        : value >= boundary;
  if (passes) return 'Normal';
  return operator.startsWith('<') || operator === '≤' ? 'High' : 'Low';
};

const safeUnlink = (filePath) => {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.warn('Unable to remove temporary lab-report upload:', error.message);
  }
};

const hasValidFileSignature = (file) => {
  if (!file?.path) return false;
  const descriptor = fs.openSync(file.path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (file.mimetype === 'application/pdf') return buffer.subarray(0, 4).toString() === '%PDF';
    if (file.mimetype === 'image/png') return buffer.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (['image/jpeg', 'image/jpg'].includes(file.mimetype)) {
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    }
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
};

async function upsertLabReportRecord(request, userId) {
  const manual = request.manual_report ? request.manual_report.toObject?.() || request.manual_report : undefined;
  const setValues = {
    lab_request_id: request._id,
    patient_id: request.patientId,
    doctor_id: request.doctorId,
    prescription_id: request.prescriptionId || undefined,
    lab_test_id: request.labTestId,
    report_type: request.testName || 'Laboratory Report',
    report_mode: request.report_mode,
    report_date: request.processing_completed_at || new Date(),
    notes: request.technician_notes || request.pathologist_notes || '',
    created_by: userId
  };
  const unsetValues = {};

  if (request.report_mode === 'manual' && manual) {
    setValues.manual_report = manual;
    unsetValues.file_url = 1;
    unsetValues.public_id = 1;
    unsetValues.file_name = 1;
    unsetValues.mime_type = 1;
    unsetValues.file_size = 1;
  } else {
    setValues.file_url = request.report_url;
    setValues.public_id = request.public_id;
    setValues.file_name = request.report_file_name;
    setValues.mime_type = request.report_mime_type;
    setValues.file_size = request.report_file_size;
    unsetValues.manual_report = 1;
  }

  await LabReport.findOneAndUpdate(
    { lab_request_id: request._id },
    { $set: setValues, ...(Object.keys(unsetValues).length ? { $unset: unsetValues } : {}) },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

// ============== LAB TEST MASTER CRUD ==============

// Create lab test
exports.createLabTest = async (req, res) => {
  try {
    const {
      code, name, category, subCategory, description,
      specimen_type, specimen_volume, container_type,
      fasting_required, fasting_hours, preparation_instructions,
      turnaround_time_hours, normal_range, critical_low, critical_high, units,
      base_price, insurance_coverage, is_active
    } = req.body;

    if (!code || !name || !category) {
      return res.status(400).json({ error: 'Code, name, and category are required' });
    }

    const existing = await LabTest.findOne({ code: code.toUpperCase() });
    if (existing) {
      return res.status(400).json({ error: 'Lab test with this code already exists' });
    }

    const labTest = new LabTest({
      code: code.toUpperCase(),
      name: name.trim(),
      category,
      subCategory: subCategory || '',
      description: description || '',
      specimen_type: specimen_type || 'Blood',
      specimen_volume: specimen_volume || '',
      container_type: container_type || '',
      fasting_required: fasting_required || false,
      fasting_hours: fasting_hours || 0,
      preparation_instructions: preparation_instructions || '',
      turnaround_time_hours: turnaround_time_hours || 24,
      normal_range: normal_range || '',
      critical_low: critical_low || '',
      critical_high: critical_high || '',
      units: units || '',
      base_price: base_price || 0,
      insurance_coverage: insurance_coverage || 'Partial',
      is_active: is_active !== undefined ? is_active : true,
      createdBy: req.user?._id
    });

    await labTest.save();
    res.status(201).json({ success: true, data: labTest });
  } catch (error) {
    console.error('Error creating lab test:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get all lab tests
exports.getLabTests = async (req, res) => {
  try {
    const { active_only = 'true', category, search } = req.query;
    const filter = {};
    
    if (active_only === 'true') filter.is_active = true;
    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } }
      ];
    }
    
    const tests = await LabTest.find(filter).sort({ name: 1 });
    res.json({ success: true, data: tests });
  } catch (error) {
    console.error('Error fetching lab tests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get lab test by ID
exports.getLabTestById = async (req, res) => {
  try {
    const { id } = req.params;
    const test = await LabTest.findById(id);
    if (!test) return res.status(404).json({ error: 'Lab test not found' });
    res.json({ success: true, data: test });
  } catch (error) {
    console.error('Error fetching lab test:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update lab test
exports.updateLabTest = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const test = await LabTest.findByIdAndUpdate(id, updates, { new: true });
    if (!test) return res.status(404).json({ error: 'Lab test not found' });
    res.json({ success: true, data: test });
  } catch (error) {
    console.error('Error updating lab test:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete lab test
exports.deleteLabTest = async (req, res) => {
  try {
    const { id } = req.params;
    await LabTest.findByIdAndDelete(id);
    res.json({ success: true, message: 'Lab test deleted successfully' });
  } catch (error) {
    console.error('Error deleting lab test:', error);
    res.status(500).json({ error: error.message });
  }
};


// ============== STRUCTURED LAB REPORT TEMPLATES ==============

exports.getReportTemplates = async (req, res) => {
  try {
    const templates = listTemplates({ q: req.query.q || '', limit: req.query.limit || 105 });
    res.json({ success: true, version: catalogVersion, count: templates.length, data: templates });
  } catch (error) {
    console.error('Error loading lab report templates:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.getReportTemplate = async (req, res) => {
  try {
    const template = getTemplate(req.params.templateId);
    if (!template) return res.status(404).json({ error: 'Lab report template not found' });
    res.json({ success: true, version: catalogVersion, data: template });
  } catch (error) {
    console.error('Error loading lab report template:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.matchReportTemplate = async (req, res) => {
  try {
    const match = matchTemplateDetailed(
      req.query.testName || '',
      req.query.testCode || '',
      req.query.templateId || ''
    );
    if (!match) return res.status(404).json({ error: 'No confident lab report template match found' });
    res.json({
      success: true,
      version: catalogVersion,
      data: match.template,
      match: {
        score: match.score,
        confidence: match.confidence,
        matchedOn: match.matchedOn
      }
    });
  } catch (error) {
    console.error('Error matching lab report template:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.saveManualReport = async (req, res) => {
  try {
    const request = await LabRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Lab request not found' });

    const template = getTemplate(req.body.templateId || request.reportTemplateId)
      || matchTemplate(request.testName, request.testCode, request.reportTemplateId);
    if (!template) {
      return res.status(400).json({ error: 'Select a valid structured report template' });
    }

    const sourceObservations = Array.isArray(req.body.observations) && req.body.observations.length
      ? req.body.observations
      : template.observations;
    if (sourceObservations.length > 250) {
      return res.status(400).json({ error: 'A laboratory report cannot contain more than 250 observations' });
    }
    const observations = sourceObservations.map(toObservation).map((observation) => ({
      ...observation,
      derivedFlag: deriveSimpleFlag(observation)
    }));
    if (!observations.some(hasEnteredResult)) {
      return res.status(400).json({ error: 'Enter at least one laboratory result before submitting' });
    }

    const sourceNarratives = Array.isArray(req.body.narrativeSections)
      ? req.body.narrativeSections
      : template.narrativeSections || [];
    const narrativeSections = sourceNarratives.map(toNarrativeSection);
    const completedAt = new Date();

    request.report_mode = 'manual';
    request.report_url = undefined;
    request.public_id = undefined;
    request.report_file_name = undefined;
    request.report_mime_type = undefined;
    request.report_file_size = undefined;
    request.manual_report = {
      templateId: template.id,
      templateNumber: template.number,
      templateVersion: catalogVersion,
      templateName: cleanText(req.body.templateName, template.name),
      specimenType: cleanText(req.body.specimenType, template.specimen),
      instrument: cleanText(req.body.instrument, template.instrument),
      observations,
      narrativeSections,
      // Reference/interpretation tables come from the server-controlled template catalog.
      additionalTables: template.additionalTables || [],
      technicianNotes: cleanText(req.body.technicianNotes || req.body.notes),
      pathologistNotes: cleanText(req.body.pathologistNotes),
      disclaimer: cleanText(template.disclaimer),
      reportedAt: completedAt,
      reportedBy: req.user?._id
    };
    request.result_value = observations
      .filter(hasEnteredResult)
      .map((item) => `${item.name}: ${item.comparator || ''}${item.resultText || item.resultNumeric}${item.unit ? ` ${item.unit}` : ''}`)
      .join('; ');
    request.result_interpretation = narrativeSections
      .filter((section) => /interpret|comment|impression|diagnosis/i.test(section.label) && cleanText(section.text))
      .map((section) => `${section.label}: ${section.text}`)
      .join('\n');
    request.normal_range_used = observations.map((item) => item.referenceText).filter(Boolean).join('; ');
    request.is_abnormal = observations.some((item) => /^(h|l|high|low|abnormal|positive|reactive|critical|very high|very low)$/i.test(item.printedFlag || item.derivedFlag));
    request.technician_notes = cleanText(req.body.technicianNotes || req.body.notes, request.technician_notes || '');
    request.pathologist_notes = cleanText(req.body.pathologistNotes, request.pathologist_notes || '');
    request.status = 'Completed';
    request.processing_completed_at = completedAt;
    await request.save();
    await upsertLabReportRecord(request, req.user?._id);

    res.json({ success: true, message: 'Structured laboratory report saved', data: request });
  } catch (error) {
    console.error('Error saving structured lab report:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.downloadGeneratedReport = async (req, res) => {
  try {
    const request = await LabRequest.findById(req.params.id)
      .populate('patientId', 'first_name last_name patientId uhid dob gender phone address')
      .populate('doctorId', 'firstName lastName specialization department')
      .populate('admissionId', 'admissionNumber')
      .populate('appointmentId', 'token')
      .populate({ path: 'prescriptionId', select: 'appointment_id', populate: { path: 'appointment_id', select: 'token' } });
    if (!request) return res.status(404).json({ error: 'Lab request not found' });

    if (request.report_mode === 'manual' && request.manual_report) {
      const hospital = req.user?.hospital_id ? await Hospital.findById(req.user.hospital_id) : null;
      return generateLabReportPdf({ res, request, hospital });
    }
    if (request.report_url) return res.redirect(request.report_url);
    return res.status(404).json({ error: 'Report not found' });
  } catch (error) {
    console.error('Error generating lab report PDF:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
};

// ============== LAB REQUEST CRUD ==============

// Create lab request (from IPD/OPD)
exports.createLabRequest = async (req, res) => {
  try {
    const {
      sourceType, admissionId, appointmentId, prescriptionId,
      patientId, doctorId, labTestId, clinical_indication,
      clinical_history, priority, scheduledDate, patient_notes
    } = req.body;

    if (!patientId || !doctorId || !labTestId) {
      return res.status(400).json({ error: 'Patient, doctor, and lab test are required' });
    }

    // Get lab test details
    const labTest = await LabTest.findById(labTestId);
    if (!labTest) {
      return res.status(404).json({ error: 'Lab test not found' });
    }

    // Validate source-specific requirements
    if (sourceType === 'IPD' && !admissionId) {
      return res.status(400).json({ error: 'Admission ID is required for IPD requests' });
    }
    if (sourceType === 'OPD' && !appointmentId && !prescriptionId) {
      return res.status(400).json({ error: 'Appointment or Prescription ID is required for OPD requests' });
    }

    // Resolve and snapshot the structured report template at request creation time.
    const matchedReportTemplate = getTemplate(labTest.report_template_id)
      || matchTemplate(labTest.name, labTest.code, labTest.report_template_id);

    // Increment usage count
    await labTest.incrementUsage();

    const request = new LabRequest({
      sourceType: sourceType || 'IPD',
      admissionId: admissionId || null,
      appointmentId: appointmentId || null,
      prescriptionId: prescriptionId || null,
      patientId,
      doctorId,
      labTestId,
      testCode: labTest.code,
      testName: labTest.name,
      category: labTest.category,
      reportTemplateId: matchedReportTemplate?.id || '',
      reportTemplateName: matchedReportTemplate?.name || '',
      clinical_indication: clinical_indication || '',
      clinical_history: clinical_history || '',
      priority: priority || 'Routine',
      scheduledDate: scheduledDate || null,
      patient_notes: patient_notes || '',
      cost: labTest.base_price,
      createdBy: req.user?._id
    });

    await request.save();

    // Populate response
    const populated = await LabRequest.findById(request._id)
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('labTestId', 'code name category report_template_id report_template_name report_template_version');

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Error creating lab request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get lab requests (with filters)
exports.getLabRequests = async (req, res) => {
  try {
    const {
      status, patientId, doctorId, admissionId, appointmentId, sourceType,
      startDate, endDate, page = 1, limit = 20
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.doctorId = doctorId;
    if (admissionId) filter.admissionId = admissionId;
    if (appointmentId) filter.appointmentId = appointmentId;
    if (sourceType) filter.sourceType = sourceType;
    
    if (startDate || endDate) {
      filter.requestedDate = {};
      if (startDate) filter.requestedDate.$gte = new Date(startDate);
      if (endDate) filter.requestedDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const requests = await LabRequest.find(filter)
      .populate('patientId', 'first_name last_name patientId phone')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('labTestId', 'code name category base_price report_template_id report_template_name report_template_version')
      .populate('sample_collected_by', 'designation employeeId')
      .populate('processed_by', 'designation employeeId')
      .populate('verifiedBy', 'designation employeeId')
      .sort({ requestedDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await LabRequest.countDocuments(filter);

    res.json({
      success: true,
      data: requests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching lab requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get lab request by ID
exports.getLabRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await LabRequest.findById(id)
      .populate('patientId', 'first_name last_name patientId phone dob gender')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('labTestId', 'code name category base_price report_template_id report_template_name report_template_version')
      .populate('sample_collected_by', 'designation employeeId')
      .populate('processed_by', 'designation employeeId')
      .populate('verifiedBy', 'designation employeeId');

    if (!request) {
      return res.status(404).json({ error: 'Lab request not found' });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Error fetching lab request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update lab request status
exports.updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const staffId = req.user?.labStaffId;

    const request = await LabRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Lab request not found' });
    }

    const previousStatus = request.status;
    request.status = status;
    
    // Update timestamps and staff based on status
    if (status === 'Approved' && previousStatus === 'Pending') {
      request.approvedBy = staffId;
      request.approvedAt = new Date();
    } else if (status === 'Sample Collected') {
      request.sample_collected_at = new Date();
      request.sample_collected_by = staffId;
    } else if (status === 'Processing') {
      request.processing_started_at = new Date();
      request.processed_by = staffId;
    } else if (status === 'Completed') {
      request.processing_completed_at = new Date();
    } else if (status === 'Verified') {
      request.verifiedBy = staffId;
      request.verifiedAt = new Date();
    }

    if (notes) {
      if (status === 'Sample Collected') request.sample_notes = notes;
      else if (status === 'Processing') request.technician_notes = notes;
      else request.pathologist_notes = notes;
    }

    await request.save();

    res.json({ success: true, message: `Request status updated to ${status}`, data: request });
  } catch (error) {
    console.error('Error updating request status:', error);
    res.status(500).json({ error: error.message });
  }
};

// Add test results
exports.addTestResults = async (req, res) => {
  try {
    const { id } = req.params;
    const { result_value, result_interpretation, technician_notes, pathologist_notes } = req.body;

    const request = await LabRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Lab request not found' });
    }

    request.result_value = result_value || '';
    request.result_interpretation = result_interpretation || '';
    if (technician_notes) request.technician_notes = technician_notes;
    if (pathologist_notes) request.pathologist_notes = pathologist_notes;
    
    // Auto-mark as completed if results are added and status was Processing
    if (request.status === 'Processing') {
      request.status = 'Completed';
      request.processing_completed_at = new Date();
    }

    await request.save();

    res.json({ success: true, message: 'Test results added successfully', data: request });
  } catch (error) {
    console.error('Error adding test results:', error);
    res.status(500).json({ error: error.message });
  }
};

// Upload lab report
exports.uploadReport = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const request = await LabRequest.findById(id);
    if (!request) {
      safeUnlink(req.file.path);
      return res.status(404).json({ error: 'Lab request not found' });
    }

    if (!hasValidFileSignature(req.file)) {
      safeUnlink(req.file.path);
      return res.status(400).json({ error: 'The uploaded file content does not match its PDF/image type' });
    }

    // Upload to Cloudinary
    const isPDF = req.file.mimetype === 'application/pdf';
    const resourceType = isPDF ? 'raw' : 'image';
    
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'lab_reports',
      resource_type: resourceType,
      public_id: `lab_${request.requestNumber}_${Date.now()}`,
      access_mode: 'public'
    });

    safeUnlink(req.file.path);

    request.report_url = result.secure_url;
    request.public_id = result.public_id;
    request.report_mode = 'uploaded';
    request.report_file_name = req.file.originalname;
    request.report_mime_type = req.file.mimetype;
    request.report_file_size = req.file.size;
    request.manual_report = undefined;
    request.processing_completed_at = request.processing_completed_at || new Date();
    if (req.body.notes) request.technician_notes = cleanText(req.body.notes);
    
    if (request.status !== 'Reported') {
      request.status = 'Completed';
    }

    await request.save();
    await upsertLabReportRecord(request, req.user?._id);

    res.json({ success: true, message: 'Report uploaded successfully', report_url: result.secure_url, data: request });
  } catch (error) {
    console.error('Error uploading report:', error);
    safeUnlink(req.file?.path);
    res.status(500).json({ error: error.message });
  }
};

// Download report
exports.downloadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await LabRequest.findById(id)
      .populate('patientId', 'first_name last_name patientId uhid dob gender phone address')
      .populate('doctorId', 'firstName lastName specialization department');
    
    if (!request) return res.status(404).json({ error: 'Report not found' });
    if (request.report_mode === 'manual' && request.manual_report) {
      const hospital = req.user?.hospital_id ? await Hospital.findById(req.user.hospital_id) : null;
      return generateLabReportPdf({ res, request, hospital });
    }
    if (!request.report_url) return res.status(404).json({ error: 'Report not found' });
    res.redirect(request.report_url);
  } catch (error) {
    console.error('Error downloading report:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get requests by admission (for IPD)
exports.getRequestsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const requests = await LabRequest.find({ 
      admissionId, 
      sourceType: 'IPD' 
    })
      .populate('labTestId', 'code name category')
      .populate('doctorId', 'firstName lastName')
      .sort({ requestedDate: -1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by admission:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get requests by patient
exports.getRequestsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const requests = await LabRequest.find({ patientId })
      .populate('labTestId', 'code name category')
      .populate('doctorId', 'firstName lastName')
      .populate('admissionId', 'admissionNumber admissionDate')
      .sort({ requestedDate: -1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by patient:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get pending requests for IPD
exports.getPendingIPDRequests = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const requests = await LabRequest.find({
      admissionId,
      sourceType: 'IPD',
      status: { $in: ['Pending', 'Approved', 'Sample Collected', 'Processing'] }
    })
      .populate('labTestId', 'code name category turnaround_time_hours report_template_id report_template_name report_template_version')
      .sort({ priority: -1, requestedDate: 1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching pending IPD requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Mark as billed
exports.markAsBilled = async (req, res) => {
  try {
    const { id } = req.params;
    const { invoiceId } = req.body;
    
    const request = await LabRequest.findByIdAndUpdate(
      id,
      { is_billed: true, invoiceId },
      { new: true }
    );
    
    if (!request) {
      return res.status(404).json({ error: 'Lab request not found' });
    }
    
    res.json({ success: true, message: 'Request marked as billed', data: request });
  } catch (error) {
    console.error('Error marking as billed:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get dashboard stats for lab
exports.getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const [pending, todayReceived, totalRequests, completedToday, reportedToday] = await Promise.all([
      LabRequest.countDocuments({ status: 'Pending' }),
      LabRequest.countDocuments({ 
        requestedDate: { $gte: today, $lt: tomorrow },
        status: { $in: ['Pending', 'Approved'] }
      }),
      LabRequest.countDocuments(),
      LabRequest.countDocuments({ 
        status: 'Completed',
        processing_completed_at: { $gte: today, $lt: tomorrow }
      }),
      LabRequest.countDocuments({ 
        status: 'Reported',
        verifiedAt: { $gte: today, $lt: tomorrow }
      })
    ]);

    // Category-wise breakdown
    const categoryBreakdown = await LabRequest.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      stats: {
        pending,
        todayReceived,
        totalRequests,
        completedToday,
        reportedToday,
        categoryBreakdown
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
};