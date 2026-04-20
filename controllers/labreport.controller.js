const LabReport = require('../models/LabReport');
const Prescription = require('../models/Prescription');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const https = require('https');
const url = require('url');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Helper function to fetch file from URL using native https
const fetchFile = (fileUrl) => {
  return new Promise((resolve, reject) => {
    const parsedUrl = url.parse(fileUrl);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };

    const protocol = parsedUrl.protocol === 'https:' ? https : require('http');
    const request = protocol.get(options, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirect
        fetchFile(response.headers.location).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to fetch: ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = response.headers['content-type'];
        resolve({ buffer, contentType });
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.end();
  });
};

exports.createLabReport = async (req, res) => {
  try {
    const report = new LabReport(req.body);
    await report.save();
    res.status(201).json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllLabReports = async (req, res) => {
  try {
    const reports = await LabReport.find()
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('prescription_id', 'prescription_number')
      .populate('lab_test_id', 'code name category')
      .sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getReportById = async (req, res) => {
  try {
    const report = await LabReport.findById(req.params.id)
      .populate('patient_id', 'first_name last_name patientId')
      .populate('doctor_id', 'firstName lastName specialization')
      .populate('prescription_id', 'prescription_number')
      .populate('lab_test_id', 'code name category');
    if (!report) return res.status(404).json({ error: 'Lab report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteReport = async (req, res) => {
  try {
    await LabReport.findByIdAndDelete(req.params.id);
    res.json({ message: 'Lab report deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get reports by patient
exports.getReportsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const reports = await LabReport.find({ patient_id: patientId })
      .populate('doctor_id', 'firstName lastName')
      .populate('lab_test_id', 'code name category')
      .sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get reports by prescription
exports.getReportsByPrescription = async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    const reports = await LabReport.find({ prescription_id: prescriptionId })
      .populate('lab_test_id', 'code name category')
      .sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Upload report file (Internal Lab)
exports.uploadReport = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { prescription_id, lab_test_id } = req.body;

    // Find prescription to get patient and doctor info
    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Prescription not found' });
    }

    // Find the specific lab test in the prescription
    const labTest = prescription.recommendedLabTests.id(lab_test_id);
    if (!labTest) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Lab test not found in prescription' });
    }

    // Determine resource type based on file mimetype
    const isPDF = req.file.mimetype === 'application/pdf';
    const resourceType = isPDF ? 'raw' : 'image';

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: isPDF ? 'lab_reports_pdf' : 'lab_reports',
      resource_type: resourceType,
      public_id: `report_${prescription.prescription_number}_${lab_test_id}_${Date.now()}`,
      access_mode: 'public',
      type: 'upload'
    });

    // Clean up local file
    fs.unlinkSync(req.file.path);

    // Use the URL as-is from Cloudinary
    const fileUrl = result.secure_url;

    // Create lab report record
    const report = new LabReport({
      patient_id: prescription.patient_id,
      doctor_id: prescription.doctor_id,
      prescription_id: prescription._id,
      lab_test_id: lab_test_id,
      report_type: labTest.lab_test_name,
      file_url: fileUrl,
      public_id: result.public_id,
      resource_type: resourceType,
      file_size: req.file.size,
      file_name: req.file.originalname,
      report_date: new Date(),
      notes: req.body.notes || '',
      created_by: req.user?._id,
      is_external: false
    });

    await report.save();

    // Update the lab test in prescription with report URL
    labTest.report_url = fileUrl;
    await prescription.save();

    res.status(201).json({
      success: true,
      message: 'Report uploaded successfully',
      file_url: fileUrl,
      is_pdf: isPDF,
      report_id: report._id,
      report
    });

  } catch (err) {
    console.error('Error uploading report:', err);
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: err.message });
  }
};

// Download/View Report - Simplified redirect approach (Recommended)
exports.downloadReport = async (req, res) => {
  try {
    const { report_id } = req.params;

    // First try to find the report in LabReport collection
    let report = await LabReport.findById(report_id);
    let reportUrl;
    let isPDF = false;

    if (report) {
      reportUrl = report.file_url;
      isPDF = reportUrl.toLowerCase().includes('.pdf');
    } else {
      // If not found, try to find from prescription
      const prescriptions = await Prescription.find({
        'recommendedLabTests.report_url': { $exists: true, $ne: null }
      });

      for (const prescription of prescriptions) {
        const labTest = prescription.recommendedLabTests.find(
          t => t.report_url && t._id.toString() === report_id
        );
        if (labTest) {
          reportUrl = labTest.report_url;
          isPDF = reportUrl.toLowerCase().includes('.pdf');
          break;
        }
      }
    }

    if (!reportUrl) {
      return res.status(404).json({ error: 'Report not found' });
    }

    // For PDFs, redirect with Cloudinary flags for better handling
    if (isPDF) {
      // Add flags to force download instead of inline viewing
      // This avoids CORS and tracking prevention issues
      let finalUrl = reportUrl;
      
      // Add fl_attachment flag to force download
      if (reportUrl.includes('cloudinary.com')) {
        finalUrl = reportUrl.replace('/upload/', '/upload/fl_attachment/');
      }
      
      // Redirect to Cloudinary with download flag
      return res.redirect(finalUrl);
    }
    
    // For images, redirect directly
    res.redirect(reportUrl);
  } catch (err) {
    console.error('Error downloading report:', err);
    res.status(500).json({ error: err.message });
  }
};

// Alternative: Stream PDF through server (if redirect doesn't work)
exports.downloadReportStream = async (req, res) => {
  try {
    const { report_id } = req.params;

    // Find the report URL
    let report = await LabReport.findById(report_id);
    let reportUrl;

    if (report) {
      reportUrl = report.file_url;
    } else {
      const prescriptions = await Prescription.find({
        'recommendedLabTests.report_url': { $exists: true, $ne: null }
      });

      for (const prescription of prescriptions) {
        const labTest = prescription.recommendedLabTests.find(
          t => t.report_url && t._id.toString() === report_id
        );
        if (labTest) {
          reportUrl = labTest.report_url;
          break;
        }
      }
    }

    if (!reportUrl) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const isPDF = reportUrl.toLowerCase().includes('.pdf');

    // Fetch the file using native https
    const { buffer, contentType } = await fetchFile(reportUrl);

    // Set headers
    res.setHeader('Content-Type', isPDF ? 'application/pdf' : contentType || 'image/jpeg');
    res.setHeader('Content-Disposition', isPDF ? 'attachment' : `inline; filename="report_${report_id}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    // Send the buffer
    res.send(buffer);
  } catch (err) {
    console.error('Error streaming report:', err);
    res.status(500).json({ error: err.message });
  }
};

// Download/View External Report - Simplified redirect approach
exports.downloadExternalReport = async (req, res) => {
  try {
    const { prescription_id, lab_test_id } = req.params;

    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const labTest = prescription.recommendedLabTests.id(lab_test_id);
    if (!labTest || !labTest.external_lab_details?.external_report_url) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const reportUrl = labTest.external_lab_details.external_report_url;
    const isPDF = reportUrl.toLowerCase().includes('.pdf');

    // For PDFs, redirect with download flag
    if (isPDF) {
      let finalUrl = reportUrl;
      
      // Add fl_attachment flag to force download
      if (reportUrl.includes('cloudinary.com')) {
        finalUrl = reportUrl.replace('/upload/', '/upload/fl_attachment/');
      }
      
      return res.redirect(finalUrl);
    }
    
    // For images, redirect directly
    res.redirect(reportUrl);
  } catch (err) {
    console.error('Error downloading external report:', err);
    res.status(500).json({ error: err.message });
  }
};

// Alternative: Stream external PDF through server
exports.downloadExternalReportStream = async (req, res) => {
  try {
    const { prescription_id, lab_test_id } = req.params;

    const prescription = await Prescription.findById(prescription_id);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const labTest = prescription.recommendedLabTests.id(lab_test_id);
    if (!labTest || !labTest.external_lab_details?.external_report_url) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const reportUrl = labTest.external_lab_details.external_report_url;
    const isPDF = reportUrl.toLowerCase().includes('.pdf');

    // Fetch the file using native https
    const { buffer, contentType } = await fetchFile(reportUrl);

    // Set headers
    res.setHeader('Content-Type', isPDF ? 'application/pdf' : contentType || 'image/jpeg');
    res.setHeader('Content-Disposition', isPDF ? 'attachment' : `inline; filename="external_report_${prescription.prescription_number}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    // Send the buffer
    res.send(buffer);
  } catch (err) {
    console.error('Error streaming external report:', err);
    res.status(500).json({ error: err.message });
  }
};