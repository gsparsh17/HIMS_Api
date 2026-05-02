const LabRequest = require('../models/LabRequest');
const LabTest = require('../models/LabTest');
const LabStaff = require('../models/LabStaff');
const IPDAdmission = require('../models/IPDAdmission');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

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
      .populate('labTestId', 'code name category');

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
      .populate('labTestId', 'code name category base_price')
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
      .populate('labTestId', 'code name category base_price')
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
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Lab request not found' });
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

    fs.unlinkSync(req.file.path);

    request.report_url = result.secure_url;
    request.public_id = result.public_id;
    
    if (request.status !== 'Reported') {
      request.status = 'Completed';
    }

    await request.save();

    res.json({ success: true, message: 'Report uploaded successfully', report_url: result.secure_url });
  } catch (error) {
    console.error('Error uploading report:', error);
    if (req.file?.path) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
};

// Download report
exports.downloadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await LabRequest.findById(id);
    
    if (!request || !request.report_url) {
      return res.status(404).json({ error: 'Report not found' });
    }

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
      .populate('labTestId', 'code name category turnaround_time_hours')
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