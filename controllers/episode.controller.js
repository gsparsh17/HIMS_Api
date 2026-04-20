const Episode = require('../models/Episode');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const LabReport = require('../models/LabReport');
const Patient = require('../models/Patient');
const mongoose = require('mongoose');

// ========== CREATE EPISODE ==========
exports.createEpisode = async (req, res) => {
    try {
        const { patientId, title, episodeType, diagnosis, icdCode, chiefComplaint, clinicalNotes, treatmentPlan, createdBy, createdByRole } = req.body;

        if (!patientId || !title || !diagnosis) {
            return res.status(400).json({ error: 'Missing required fields: patientId, title, diagnosis' });
        }

        // Check if patient exists
        const patient = await Patient.findById(patientId);
        if (!patient) {
            return res.status(404).json({ error: 'Patient not found' });
        }

        const episode = new Episode({
            patientId,
            title,
            episodeType: episodeType || 'General',
            diagnosis,
            icdCode,
            startDate: new Date(),
            status: 'Active',
            chiefComplaint,
            clinicalNotes,
            treatmentPlan,
            createdBy,
            createdByRole: createdByRole || 'doctor'
        });

        await episode.save();

        res.status(201).json({
            success: true,
            message: 'Episode created successfully',
            episode
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// ========== GET EPISODES BY PATIENT ==========
exports.getEpisodesByPatient = async (req, res) => {
    try {
        const { patientId } = req.params;
        const { status, episodeType } = req.query;

        const filter = { patientId };
        if (status) filter.status = status;
        if (episodeType) filter.episodeType = episodeType;

        const episodes = await Episode.find(filter)
            .sort({ startDate: -1 })
            .populate('createdBy', 'firstName lastName')
            .populate('closedBy', 'firstName lastName');

        // Get counts for each episode
        const episodesWithStats = await Promise.all(episodes.map(async (episode) => {
            const appointmentCount = await Appointment.countDocuments({ episodeId: episode._id });
            const prescriptionCount = await Prescription.countDocuments({ episodeId: episode._id });
            const labReportCount = await LabReport.countDocuments({ episodeId: episode._id });

            return {
                ...episode.toObject(),
                stats: {
                    appointments: appointmentCount,
                    prescriptions: prescriptionCount,
                    labReports: labReportCount
                }
            };
        }));

        res.json({
            success: true,
            count: episodesWithStats.length,
            episodes: episodesWithStats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ========== GET ACTIVE EPISODE BY PATIENT AND DIAGNOSIS ==========
exports.getActiveEpisodeByDiagnosis = async (req, res) => {
    try {
        const { patientId, diagnosis } = req.params;

        // Search for active episode with similar diagnosis
        const episode = await Episode.findOne({
            patientId,
            status: 'Active',
            diagnosis: { $regex: diagnosis, $options: 'i' }
        }).sort({ startDate: -1 });

        res.json({
            success: true,
            hasActiveEpisode: !!episode,
            episode: episode || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ========== GET EPISODE BY ID ==========
exports.getEpisodeById = async (req, res) => {
    try {
        const { episodeId } = req.params;

        const episode = await Episode.findById(episodeId)
            .populate('patientId', 'first_name last_name patientId phone')
            .populate('createdBy', 'firstName lastName')
            .populate('closedBy', 'firstName lastName');

        if (!episode) {
            return res.status(404).json({ error: 'Episode not found' });
        }

        // Get all related data
        const appointments = await Appointment.find({ episodeId: episode._id })
            .populate('doctor_id', 'firstName lastName specialization')
            .populate('department_id', 'name')
            .sort({ appointment_date: 1 });

        const prescriptions = await Prescription.find({ episodeId: episode._id })
            .populate('doctor_id', 'firstName lastName')
            .sort({ created_at: 1 });

        const labReports = await LabReport.find({ episodeId: episode._id })
            .sort({ created_at: 1 });

        res.json({
            success: true,
            episode,
            appointments,
            prescriptions,
            labReports
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ========== UPDATE EPISODE ==========
exports.updateEpisode = async (req, res) => {
    try {
        const { episodeId } = req.params;
        const updates = req.body;

        const episode = await Episode.findByIdAndUpdate(
            episodeId,
            { ...updates, updatedAt: new Date() },
            { new: true, runValidators: true }
        );

        if (!episode) {
            return res.status(404).json({ error: 'Episode not found' });
        }

        res.json({
            success: true,
            message: 'Episode updated successfully',
            episode
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// ========== CLOSE EPISODE ==========
exports.closeEpisode = async (req, res) => {
    try {
        const { episodeId } = req.params;
        const { closedReason, outcome, closedBy } = req.body;

        const episode = await Episode.findByIdAndUpdate(
            episodeId,
            {
                status: 'Closed',
                endDate: new Date(),
                closedReason,
                outcome: outcome || 'Resolved',
                closedBy,
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!episode) {
            return res.status(404).json({ error: 'Episode not found' });
        }

        res.json({
            success: true,
            message: 'Episode closed successfully',
            episode
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// ========== REOPEN EPISODE ==========
exports.reopenEpisode = async (req, res) => {
    try {
        const { episodeId } = req.params;

        const episode = await Episode.findByIdAndUpdate(
            episodeId,
            {
                status: 'Active',
                endDate: null,
                closedReason: null,
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!episode) {
            return res.status(404).json({ error: 'Episode not found' });
        }

        res.json({
            success: true,
            message: 'Episode reopened successfully',
            episode
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

// backend/controllers/episode.controller.js
exports.linkAppointmentToEpisode = async (req, res) => {
    try {
        const { appointmentId, episodeId } = req.body;

        console.log('Linking appointment:', { appointmentId, episodeId });

        const Appointment = mongoose.model('Appointment');

        const appointment = await Appointment.findByIdAndUpdate(
            appointmentId,
            { episodeId },
            { new: true }
        );

        if (!appointment) {
            return res.status(404).json({
                success: false,
                error: 'Appointment not found'
            });
        }

        console.log('Appointment linked successfully:', appointment._id);

        res.json({
            success: true,
            message: 'Appointment linked to episode successfully',
            appointment
        });
    } catch (err) {
        console.error('Error linking appointment:', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
};

// ========== SUGGEST EPISODE FOR DIAGNOSIS ==========
exports.suggestEpisode = async (req, res) => {
    try {
        const { patientId, diagnosis } = req.query;

        console.log('Suggest episode called with:', { patientId, diagnosis });

        if (!patientId || !diagnosis) {
            return res.status(400).json({
                success: false,
                error: 'Patient ID and diagnosis are required'
            });
        }

        // Validate patientId is valid ObjectId
        const mongoose = require('mongoose');
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid patient ID format'
            });
        }

        // Look for active episodes with similar diagnosis
        const activeEpisodes = await Episode.find({
            patientId: new mongoose.Types.ObjectId(patientId),
            status: 'Active',
            diagnosis: { $regex: diagnosis, $options: 'i' }
        }).sort({ startDate: -1 });

        // Also check for recent closed episodes that might be reopened (last 90 days)
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

        const recentClosedEpisodes = await Episode.find({
            patientId: new mongoose.Types.ObjectId(patientId),
            status: 'Closed',
            diagnosis: { $regex: diagnosis, $options: 'i' },
            endDate: { $gte: ninetyDaysAgo }
        }).sort({ endDate: -1 });

        // Get stats for each active episode
        const activeWithStats = await Promise.all(activeEpisodes.map(async (episode) => {
            const appointmentCount = await mongoose.model('Appointment').countDocuments({ episodeId: episode._id });
            return {
                ...episode.toObject(),
                stats: { appointments: appointmentCount }
            };
        }));

        const closedWithStats = await Promise.all(recentClosedEpisodes.map(async (episode) => {
            const appointmentCount = await mongoose.model('Appointment').countDocuments({ episodeId: episode._id });
            return {
                ...episode.toObject(),
                stats: { appointments: appointmentCount }
            };
        }));

        res.json({
            success: true,
            suggestions: {
                active: activeWithStats,
                recentClosed: closedWithStats
            },
            hasActiveEpisode: activeEpisodes.length > 0,
            hasRecentClosed: recentClosedEpisodes.length > 0
        });
    } catch (err) {
        console.error('Error in suggestEpisode:', err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
};

// ========== GET EPISODE TIMELINE ==========
exports.getEpisodeTimeline = async (req, res) => {
    try {
        const { episodeId } = req.params;

        const episode = await Episode.findById(episodeId);
        if (!episode) {
            return res.status(404).json({ error: 'Episode not found' });
        }

        // Get all events in chronological order
        const appointments = await Appointment.find({ episodeId: episode._id })
            .populate('doctor_id', 'firstName lastName')
            .select('appointment_date status appointment_type notes created_at');

        const prescriptions = await Prescription.find({ episodeId: episode._id })
            .populate('doctor_id', 'firstName lastName')
            .select('created_at medicines');

        const labReports = await LabReport.find({ episodeId: episode._id })
            .select('created_at test_name result status');

        // Combine and sort all events
        const timeline = [
            ...appointments.map(a => ({
                type: 'appointment',
                date: a.appointment_date || a.created_at,
                data: a
            })),
            ...prescriptions.map(p => ({
                type: 'prescription',
                date: p.created_at,
                data: p
            })),
            ...labReports.map(l => ({
                type: 'lab_report',
                date: l.createdAt,
                data: l
            }))
        ].sort((a, b) => new Date(a.date) - new Date(b.date));

        res.json({
            success: true,
            episode,
            timeline
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};