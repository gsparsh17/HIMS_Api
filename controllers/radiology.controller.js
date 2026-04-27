const RadiologyRequest = require('../models/RadiologyRequest');
const ImagingTest = require('../models/ImagingTest');
const RadiologyStaff = require('../models/RadiologyStaff');
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

// ============== IMAGING TEST MASTER CRUD ==============

// Create imaging test
exports.createImagingTest = async (req, res) => {
  try {
    const {
      code, name, category, description, preparation_instructions,
      contraindications, contrast_required, contrast_details,
      turnaround_time_hours, base_price, insurance_coverage, is_active
    } = req.body;

    if (!code || !name || !category) {
      return res.status(400).json({ error: 'Code, name, and category are required' });
    }

    const existing = await ImagingTest.findOne({ code: code.toUpperCase() });
    if (existing) {
      return res.status(400).json({ error: 'Imaging test with this code already exists' });
    }

    const imagingTest = new ImagingTest({
      code: code.toUpperCase(),
      name: name.trim(),
      category,
      description: description || '',
      preparation_instructions: preparation_instructions || '',
      contraindications: contraindications || '',
      contrast_required: contrast_required || false,
      contrast_details: contrast_details || '',
      turnaround_time_hours: turnaround_time_hours || 24,
      base_price: base_price || 0,
      insurance_coverage: insurance_coverage || 'Partial',
      is_active: is_active !== undefined ? is_active : true,
      createdBy: req.user?._id
    });

    await imagingTest.save();
    res.status(201).json({ success: true, data: imagingTest });
  } catch (error) {
    console.error('Error creating imaging test:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get all imaging tests
exports.getImagingTests = async (req, res) => {
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
    
    const tests = await ImagingTest.find(filter).sort({ name: 1 });
    res.json({ success: true, data: tests });
  } catch (error) {
    console.error('Error fetching imaging tests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update imaging test
exports.updateImagingTest = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const test = await ImagingTest.findByIdAndUpdate(id, updates, { new: true });
    if (!test) return res.status(404).json({ error: 'Imaging test not found' });
    res.json({ success: true, data: test });
  } catch (error) {
    console.error('Error updating imaging test:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete imaging test
exports.deleteImagingTest = async (req, res) => {
  try {
    const { id } = req.params;
    await ImagingTest.findByIdAndDelete(id);
    res.json({ success: true, message: 'Imaging test deleted successfully' });
  } catch (error) {
    console.error('Error deleting imaging test:', error);
    res.status(500).json({ error: error.message });
  }
};

// ============== RADIOLOGY REQUEST CRUD ==============

// Create radiology request (from IPD/OPD)
exports.createRadiologyRequest = async (req, res) => {
  try {
    const {
      sourceType, admissionId, patientId, doctorId,
      imagingTestId, clinical_indication, clinical_history,
      priority, scheduledDate, patient_notes
    } = req.body;

    // Validate required fields
    if (!patientId || !doctorId || !imagingTestId) {
      return res.status(400).json({ error: 'Patient, doctor, and imaging test are required' });
    }

    // Get imaging test details
    const imagingTest = await ImagingTest.findById(imagingTestId);
    if (!imagingTest) {
      return res.status(404).json({ error: 'Imaging test not found' });
    }

    // If source is IPD, validate admission
    if (sourceType === 'IPD' && !admissionId) {
      return res.status(400).json({ error: 'Admission ID is required for IPD requests' });
    }

    // Increment usage count
    await imagingTest.incrementUsage();

    const request = new RadiologyRequest({
      sourceType: sourceType || 'IPD',
      admissionId: admissionId || null,
      patientId,
      doctorId,
      imagingTestId,
      testCode: imagingTest.code,
      testName: imagingTest.name,
      category: imagingTest.category,
      clinical_indication: clinical_indication || '',
      clinical_history: clinical_history || '',
      priority: priority || 'Routine',
      scheduledDate: scheduledDate || null,
      patient_notes: patient_notes || '',
      cost: imagingTest.base_price,
      createdBy: req.user?._id
    });

    await request.save();

    // Populate response
    const populated = await RadiologyRequest.findById(request._id)
      .populate('patientId', 'first_name last_name patientId')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('imagingTestId', 'code name category');

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Error creating radiology request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get radiology requests (with filters)
exports.getRadiologyRequests = async (req, res) => {
  try {
    const {
      status, patientId, doctorId, admissionId, sourceType,
      startDate, endDate, page = 1, limit = 20
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (patientId) filter.patientId = patientId;
    if (doctorId) filter.doctorId = doctorId;
    if (admissionId) filter.admissionId = admissionId;
    if (sourceType) filter.sourceType = sourceType;
    
    if (startDate || endDate) {
      filter.requestedDate = {};
      if (startDate) filter.requestedDate.$gte = new Date(startDate);
      if (endDate) filter.requestedDate.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const requests = await RadiologyRequest.find(filter)
      .populate('patientId', 'first_name last_name patientId phone')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('imagingTestId', 'code name category base_price')
      .populate('approvedBy', 'designation employeeId')
      .populate('performedBy', 'designation employeeId')
      .populate('reportedBy', 'designation employeeId')
      .sort({ requestedDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await RadiologyRequest.countDocuments(filter);

    res.json({
      success: true,
      data: requests,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching radiology requests:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get radiology request by ID
exports.getRadiologyRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await RadiologyRequest.findById(id)
      .populate('patientId', 'first_name last_name patientId phone dob gender')
      .populate('doctorId', 'firstName lastName specialization')
      .populate('imagingTestId', 'code name category base_price preparation_instructions')
      .populate('approvedBy', 'designation employeeId')
      .populate('performedBy', 'designation employeeId')
      .populate('reportedBy', 'designation employeeId');

    if (!request) {
      return res.status(404).json({ error: 'Radiology request not found' });
    }

    res.json({ success: true, data: request });
  } catch (error) {
    console.error('Error fetching radiology request:', error);
    res.status(500).json({ error: error.message });
  }
};

// Update radiology request status
exports.updateRequestStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const staffId = req.user?.radiologyStaffId;

    const request = await RadiologyRequest.findById(id);
    if (!request) {
      return res.status(404).json({ error: 'Radiology request not found' });
    }

    request.status = status;
    
    // Update timestamps based on status
    if (status === 'Approved') {
      request.approvedBy = staffId;
      request.approvedAt = new Date();
    } else if (status === 'In Progress') {
      request.performedBy = staffId;
      request.performedAt = new Date();
    } else if (status === 'Reported') {
      request.reportedBy = staffId;
      request.reportedAt = new Date();
    }

    if (notes) {
      if (status === 'In Progress') request.technician_notes = notes;
      else request.radiologist_notes = notes;
    }

    await request.save();

    res.json({ success: true, message: `Request status updated to ${status}`, data: request });
  } catch (error) {
    console.error('Error updating request status:', error);
    res.status(500).json({ error: error.message });
  }
};

// Upload radiology report
exports.uploadReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { findings, impression } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const request = await RadiologyRequest.findById(id);
    if (!request) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Radiology request not found' });
    }

    // Upload to Cloudinary
    const isPDF = req.file.mimetype === 'application/pdf';
    const resourceType = isPDF ? 'raw' : 'image';
    
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'radiology_reports',
      resource_type: resourceType,
      public_id: `rad_${request.requestNumber}_${Date.now()}`,
      access_mode: 'public'
    });

    fs.unlinkSync(req.file.path);

    request.findings = findings || '';
    request.impression = impression || '';
    request.report_url = result.secure_url;
    request.public_id = result.public_id;
    
    if (request.status !== 'Reported') {
      request.status = 'Reported';
      request.reportedAt = new Date();
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
    const request = await RadiologyRequest.findById(id);
    
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
    const requests = await RadiologyRequest.find({ 
      admissionId, 
      sourceType: 'IPD' 
    })
      .populate('imagingTestId', 'code name category')
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
    const requests = await RadiologyRequest.find({ patientId })
      .populate('imagingTestId', 'code name category')
      .populate('doctorId', 'firstName lastName')
      .populate('admissionId', 'admissionNumber admissionDate')
      .sort({ requestedDate: -1 });
    
    res.json({ success: true, data: requests });
  } catch (error) {
    console.error('Error fetching requests by patient:', error);
    res.status(500).json({ error: error.message });
  }
};

// Mark as billed
exports.markAsBilled = async (req, res) => {
  try {
    const { id } = req.params;
    const { invoiceId } = req.body;
    
    const request = await RadiologyRequest.findByIdAndUpdate(
      id,
      { is_billed: true, invoiceId },
      { new: true }
    );
    
    if (!request) {
      return res.status(404).json({ error: 'Radiology request not found' });
    }
    
    res.json({ success: true, message: 'Request marked as billed', data: request });
  } catch (error) {
    console.error('Error marking as billed:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get dashboard stats for radiology
exports.getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const [pending, todayScheduled, totalRequests, completedToday, reportedToday] = await Promise.all([
      RadiologyRequest.countDocuments({ status: 'Pending' }),
      RadiologyRequest.countDocuments({ 
        scheduledDate: { $gte: today, $lt: tomorrow },
        status: { $in: ['Scheduled', 'Approved'] }
      }),
      RadiologyRequest.countDocuments(),
      RadiologyRequest.countDocuments({ 
        status: 'Completed',
        performedAt: { $gte: today, $lt: tomorrow }
      }),
      RadiologyRequest.countDocuments({ 
        status: 'Reported',
        reportedAt: { $gte: today, $lt: tomorrow }
      })
    ]);

    res.json({
      success: true,
      stats: {
        pending,
        todayScheduled,
        totalRequests,
        completedToday,
        reportedToday
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ error: error.message });
  }
};