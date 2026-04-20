const Prescription = require('../models/Prescription');
const LabReport = require('../models/LabReport');
const Patient = require('../models/Patient');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ========== MARK LAB TEST AS REFERRED TO EXTERNAL LAB ==========
exports.markAsReferredOut = async (req, res) => {
    try {
        const { prescription_id, lab_test_id } = req.params;
        const {
            lab_name,
            lab_address,
            contact_person,
            contact_phone,
            reference_number,
            handover_notes,
            courier_name,
            tracking_number
        } = req.body;

        const prescription = await Prescription.findById(prescription_id);
        if (!prescription) {
            return res.status(404).json({ error: 'Prescription not found' });
        }

        const labIndex = prescription.recommendedLabTests.findIndex(
            t => t._id.toString() === lab_test_id
        );

        if (labIndex === -1) {
            return res.status(404).json({ error: 'Lab test not found in this prescription' });
        }

        const labTest = prescription.recommendedLabTests[labIndex];

        // Update lab test with external lab details
        labTest.is_referred_out = true;
        labTest.status = 'Referred Out';
        labTest.external_lab_details = {
            lab_name,
            lab_address,
            contact_person,
            contact_phone,
            reference_number,
            referred_out_date: new Date()
        };

        // Add sample handover log entry
        labTest.sample_handover_log = labTest.sample_handover_log || [];
        labTest.sample_handover_log.push({
            handed_over_by: req.user?._id,
            handed_over_at: new Date(),
            courier_name: courier_name || '',
            tracking_number: tracking_number || '',
            notes: handover_notes || '',
            received_by_external: false
        });

        await prescription.save();

        res.json({
            success: true,
            message: 'Lab test marked as referred to external lab',
            labTest: labTest
        });
    } catch (err) {
        console.error('Error marking as referred out:', err);
        res.status(500).json({ error: err.message });
    }
};

// ========== ADD SAMPLE HANDOVER LOG ==========
exports.addSampleHandoverLog = async (req, res) => {
    try {
        const { prescription_id, lab_test_id } = req.params;
        const { courier_name, tracking_number, notes, received_by_external } = req.body;

        const prescription = await Prescription.findById(prescription_id);
        if (!prescription) {
            return res.status(404).json({ error: 'Prescription not found' });
        }

        const labIndex = prescription.recommendedLabTests.findIndex(
            t => t._id.toString() === lab_test_id
        );

        if (labIndex === -1) {
            return res.status(404).json({ error: 'Lab test not found in this prescription' });
        }

        const labTest = prescription.recommendedLabTests[labIndex];
        labTest.sample_handover_log = labTest.sample_handover_log || [];
        labTest.sample_handover_log.push({
            handed_over_by: req.user?._id,
            handed_over_at: new Date(),
            courier_name,
            tracking_number,
            notes,
            received_by_external: received_by_external || false
        });

        await prescription.save();

        const updatedLabTest = prescription.recommendedLabTests[labIndex];

        res.json({
            success: true,
            message: 'Sample handover log added',
            sampleHandoverLog: updatedLabTest.sample_handover_log
        });
    } catch (err) {
        console.error('Error adding sample handover log:', err);
        res.status(500).json({ error: err.message });
    }
};

// ========== GET SAMPLE HANDOVER LOGS ==========
exports.getSampleHandoverLogs = async (req, res) => {
    try {
        const { prescription_id, lab_test_id } = req.params;

        const prescription = await Prescription.findById(prescription_id);
        if (!prescription) {
            return res.status(404).json({ error: 'Prescription not found' });
        }

        const labTest = prescription.recommendedLabTests.find(
            t => t._id.toString() === lab_test_id
        );

        if (!labTest) {
            return res.status(404).json({ error: 'Lab test not found' });
        }

        res.json({
            success: true,
            sampleHandoverLogs: labTest.sample_handover_log || []
        });
    } catch (err) {
        console.error('Error fetching sample handover logs:', err);
        res.status(500).json({ error: err.message });
    }
};

// ========== UPLOAD EXTERNAL LAB REPORT ==========
exports.uploadExternalReport = async (req, res) => {
    try {
        const { prescription_id, lab_test_id } = req.params;
        const { reference_number, notes } = req.body;

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const prescription = await Prescription.findById(prescription_id);
        if (!prescription) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Prescription not found' });
        }

        const labIndex = prescription.recommendedLabTests.findIndex(
            t => t._id.toString() === lab_test_id
        );

        if (labIndex === -1) {
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'Lab test not found in this prescription' });
        }

        const labTest = prescription.recommendedLabTests[labIndex];

        // Verify reference number if provided
        if (reference_number && labTest.external_lab_details?.reference_number !== reference_number) {
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                error: 'Reference number does not match. Please check and try again.'
            });
        }

        // Determine resource type based on file mimetype
        const isPDF = req.file.mimetype === 'application/pdf';
        const resourceType = isPDF ? 'raw' : 'image';

        // Upload to Cloudinary (no manual URL modification)
        const result = await cloudinary.uploader.upload(req.file.path, {
            folder: isPDF ? 'external_lab_reports_pdf' : 'external_lab_reports',
            resource_type: resourceType,
            public_id: `external_${prescription.prescription_number}_${lab_test_id}_${Date.now()}`,
            access_mode: 'public',
            type: 'upload'
        });

        // Clean up local file
        fs.unlinkSync(req.file.path);

        // Use the URL as-is from Cloudinary
        const fileUrl = result.secure_url;

        // Initialize external_lab_details if it doesn't exist
        if (!labTest.external_lab_details) {
            labTest.external_lab_details = {};
        }

        // Update lab test with external report
        labTest.external_lab_details.external_report_url = fileUrl;
        labTest.external_lab_details.external_report_received_date = new Date();
        labTest.status = 'Completed';
        labTest.completed_date = new Date();
        labTest.external_report_uploaded_by = req.user?._id;
        labTest.external_report_uploaded_at = new Date();

        // Add to lab reports collection
        const labReport = new LabReport({
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
            notes: notes || `External lab report. Reference: ${reference_number || 'N/A'}`,
            created_by: req.user?._id,
            is_external: true,
            external_lab_name: labTest.external_lab_details?.lab_name
        });

        await labReport.save();

        // Update lab test in prescription with report reference
        labTest.report_url = fileUrl;

        // Update prescription lab test status
        const totalLabTests = prescription.recommendedLabTests.length;
        const completedLabTests = prescription.recommendedLabTests.filter(t => t.status === 'Completed').length;

        if (completedLabTests === totalLabTests) {
            prescription.lab_tests_status = 'Completed';
        } else if (completedLabTests > 0) {
            prescription.lab_tests_status = 'Partial';
        }

        await prescription.save();

        res.json({
            success: true,
            message: 'External lab report uploaded successfully',
            file_url: fileUrl,
            is_pdf: isPDF,
            labReport
        });
    } catch (err) {
        console.error('Error uploading external report:', err);
        if (req.file && req.file.path) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: err.message });
    }
};

// ========== GET ALL REFERRED OUT LAB TESTS ==========
exports.getReferredOutLabTests = async (req, res) => {
    try {
        const { status, start_date, end_date } = req.query;

        const filter = {
            'recommendedLabTests.is_referred_out': true
        };

        if (status) {
            filter['recommendedLabTests.status'] = status;
        }

        const prescriptions = await Prescription.find(filter)
            .populate('patient_id', 'first_name last_name patientId phone email')
            .populate('doctor_id', 'firstName lastName specialization')
            .populate('recommendedLabTests.external_report_uploaded_by', 'firstName lastName')
            .sort({ issue_date: -1 });

        // Extract referred out lab tests
        const referredOutTests = [];
        prescriptions.forEach(prescription => {
            (prescription.recommendedLabTests || []).forEach(test => {
                if (test.is_referred_out) {
                    referredOutTests.push({
                        prescription_id: prescription._id,
                        prescription_number: prescription.prescription_number,
                        patient: prescription.patient_id,
                        doctor: prescription.doctor_id,
                        diagnosis: prescription.diagnosis,
                        lab_test: test,
                        external_lab_details: test.external_lab_details,
                        sample_handover_log: test.sample_handover_log
                    });
                }
            });
        });

        res.json({
            success: true,
            count: referredOutTests.length,
            referredOutTests
        });
    } catch (err) {
        console.error('Error fetching referred out lab tests:', err);
        res.status(500).json({ error: err.message });
    }
};

// ========== GET EXTERNAL LAB REPORT BY ID ==========
exports.getExternalReportById = async (req, res) => {
    try {
        const { report_id } = req.params;

        const labReport = await LabReport.findById(report_id)
            .populate('patient_id', 'first_name last_name patientId')
            .populate('doctor_id', 'firstName lastName')
            .populate('created_by', 'firstName lastName');

        if (!labReport) {
            return res.status(404).json({ error: 'Report not found' });
        }

        res.json({
            success: true,
            report: labReport
        });
    } catch (err) {
        console.error('Error fetching external report:', err);
        res.status(500).json({ error: err.message });
    }
};

// ========== UPDATE EXTERNAL LAB STATUS ==========
exports.updateExternalLabStatus = async (req, res) => {
    try {
        const { prescription_id, lab_test_id } = req.params;
        const { status, notes } = req.body;

        const prescription = await Prescription.findById(prescription_id);
        if (!prescription) {
            return res.status(404).json({ error: 'Prescription not found' });
        }

        const labIndex = prescription.recommendedLabTests.findIndex(
            t => t._id.toString() === lab_test_id
        );

        if (labIndex === -1) {
            return res.status(404).json({ error: 'Lab test not found' });
        }

        prescription.recommendedLabTests[labIndex].status = status;
        if (notes) {
            prescription.recommendedLabTests[labIndex].notes =
                prescription.recommendedLabTests[labIndex].notes
                    ? `${prescription.recommendedLabTests[labIndex].notes}\n${notes}`
                    : notes;
        }

        if (status === 'Completed') {
            prescription.recommendedLabTests[labIndex].completed_date = new Date();
        }

        await prescription.save();

        res.json({
            success: true,
            message: 'External lab test status updated',
            labTest: prescription.recommendedLabTests[labIndex]
        });
    } catch (err) {
        console.error('Error updating external lab status:', err);
        res.status(500).json({ error: err.message });
    }
};