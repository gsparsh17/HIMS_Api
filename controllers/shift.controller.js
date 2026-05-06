const Shift = require('../models/Shift');
const Staff = require('../models/Staff');
const ShiftHandover = require('../models/ShiftHandover');
const IPDAdmission = require('../models/IPDAdmission');
const NursingNote = require('../models/NursingNote');
const IPDVitals = require('../models/IPDVitals');

// ========== BASIC SHIFT CRUD ==========

exports.createShift = async (req, res) => {
  try {
    const shift = new Shift(req.body);
    await shift.save();
    res.status(201).json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllShifts = async (req, res) => {
  try {
    let shifts = await Shift.find();
    
    // Auto-create default shifts if the collection is empty
    if (shifts.length === 0) {
      const defaultShifts = [
        { name: 'Morning', start_time: '07:00', end_time: '15:00' },
        { name: 'Evening', start_time: '15:00', end_time: '23:00' },
        { name: 'Night', start_time: '23:00', end_time: '07:00' }
      ];
      shifts = await Shift.insertMany(defaultShifts);
    }
    
    res.json(shifts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateShift = async (req, res) => {
  try {
    const shift = await Shift.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteShift = async (req, res) => {
  try {
    await Shift.findByIdAndDelete(req.params.id);
    res.json({ message: 'Shift deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getShiftById = async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== SHIFT HANDOVER SYSTEM ==========

/**
 * Determine current shift based on hour of day
 */
const getCurrentShift = () => {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 14) return 'Morning';
  if (hour >= 14 && hour < 22) return 'Evening';
  return 'Night';
};

/**
 * Get the next shift name
 */
const getNextShift = (current) => {
  if (current === 'Morning') return 'Evening';
  if (current === 'Evening') return 'Night';
  return 'Morning';
};

/**
 * Map shift name to the corresponding Shift document
 */
const findShiftDoc = async (shiftName) => {
  return Shift.findOne({ name: { $regex: new RegExp(`^${shiftName}$`, 'i') } });
};

/**
 * Auto-assign incoming nurse based on:
 * 1. The nurse must be assigned to the next shift
 * 2. The nurse must have the fewest active handovers (workload balancing)
 * 3. Exclude the outgoing nurse
 */
exports.getAvailableNursesForHandover = async (req, res) => {
  try {
    const { outgoingNurseId } = req.params;
    const currentShift = getCurrentShift();
    const nextShiftName = getNextShift(currentShift);

    // Find the Shift document that matches the next shift
    const nextShiftDoc = await findShiftDoc(nextShiftName);

    // Fetch ALL hospital nurses (except outgoing) so user has full visibility
    const availableNurses = await Staff.find({
      role: { $regex: /nurse/i },
      _id: { $ne: outgoingNurseId }
    }).populate('shift', 'name start_time end_time')
      .populate('department', 'name');

    // Count active (unacknowledged) handovers per nurse to determine workload
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const nurseWorkloads = await Promise.all(
      availableNurses.map(async (nurse) => {
        const activeHandovers = await ShiftHandover.countDocuments({
          incomingNurse: nurse._id,
          status: { $in: ['Submitted', 'Draft'] },
          handoverDate: { $gte: today }
        });
        
        const isNextShift = nextShiftDoc && nurse.shift && nurse.shift._id.toString() === nextShiftDoc._id.toString();

        return {
          nurse: {
            _id: nurse._id,
            first_name: nurse.first_name,
            last_name: nurse.last_name,
            email: nurse.email,
            phone: nurse.phone,
            department: nurse.department,
            shift: nurse.shift
          },
          activeHandovers,
          isNextShift,
          isRecommended: false
        };
      })
    );

    // Sort: Next shift nurses first, then by workload (fewest handovers first)
    nurseWorkloads.sort((a, b) => {
      if (a.isNextShift && !b.isNextShift) return -1;
      if (!a.isNextShift && b.isNextShift) return 1;
      return a.activeHandovers - b.activeHandovers;
    });

    if (nurseWorkloads.length > 0) {
      nurseWorkloads[0].isRecommended = true;
    }

    const isFallback = !nurseWorkloads.some(n => n.isNextShift);

    res.json({
      success: true,
      currentShift,
      nextShift: nextShiftName,
      nurses: nurseWorkloads,
      isFallback,
      recommendedNurse: nurseWorkloads.length > 0 ? nurseWorkloads[0].nurse : null
    });
  } catch (err) {
    console.error('Error getting available nurses:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get handover data pre-filled for all active patients (ISBAR auto-populate)
 */
exports.getHandoverPatientData = async (req, res) => {
  try {
    // Get all active admissions
    const admissions = await IPDAdmission.find({
      status: { $in: ['Admitted', 'Under Treatment'] }
    })
      .populate('patientId', 'first_name last_name gender dob patientId allergies')
      .populate('primaryDoctorId', 'firstName lastName')
      .populate('bedId', 'bedNumber bedType')
      .populate('departmentId', 'name');

    // For each admission, gather ISBAR data
    const patientData = await Promise.all(
      admissions.map(async (adm) => {
        // Get latest vitals
        const latestVitals = await IPDVitals.findOne({ admissionId: adm._id })
          .sort({ recordedAt: -1 });

        // Get recent nursing notes (last 24h)
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const recentNotes = await NursingNote.find({
          admissionId: adm._id,
          noteDateTime: { $gte: yesterday }
        }).sort({ noteDateTime: -1 }).limit(5);

        const patient = adm.patientId;
        const age = patient?.dob
          ? Math.floor((new Date() - new Date(patient.dob)) / (365.25 * 24 * 60 * 60 * 1000))
          : 'N/A';

        // Build ISBAR structure
        const isbar = {
          identify: {
            patientName: patient ? `${patient.first_name} ${patient.last_name || ''}` : 'Unknown',
            patientId: patient?.patientId || '',
            age: `${age} yrs`,
            gender: patient?.gender || '',
            bedNumber: adm.bedId?.bedNumber || '',
            admissionDate: adm.admissionDate,
            primaryDoctor: adm.primaryDoctorId ? `Dr. ${adm.primaryDoctorId.firstName} ${adm.primaryDoctorId.lastName}` : '',
            allergies: patient?.allergies || ''
          },
          situation: {
            reasonForAdmission: adm.reasonForAdmission || '',
            currentCondition: 'Stable',
            primaryDiagnosis: adm.clinicalInfo?.diagnosis || '',
            recentChanges: ''
          },
          background: {
            medicalHistory: adm.clinicalInfo?.pastHistory || '',
            currentMedications: '',
            recentProcedures: '',
            relevantLabResults: ''
          },
          assessment: {
            latestVitals: latestVitals
              ? `BP: ${latestVitals.bloodPressure?.systolic || '-'}/${latestVitals.bloodPressure?.diastolic || '-'}, Pulse: ${latestVitals.pulse || '-'}, Temp: ${latestVitals.temperature || '-'}°F, SpO2: ${latestVitals.spo2 || '-'}%`
              : 'No vitals recorded',
            painScore: latestVitals?.painScore || 0,
            consciousnessLevel: 'Alert',
            nursingAssessment: recentNotes.length > 0 ? recentNotes[0].note : '',
            ivLines: '',
            drains: '',
            inputOutput: ''
          },
          recommendation: {
            pendingTasks: '',
            pendingInvestigations: '',
            medicationsDue: '',
            specialInstructions: '',
            escalationPlan: ''
          }
        };

        return {
          admissionId: adm._id,
          isbar
        };
      })
    );

    res.json({
      success: true,
      patients: patientData,
      currentShift: getCurrentShift(),
      nextShift: getNextShift(getCurrentShift())
    });
  } catch (err) {
    console.error('Error getting handover patient data:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Create / Submit Shift Handover
 */
exports.createHandover = async (req, res) => {
  try {
    const {
      outgoingNurseId,
      incomingNurseId,
      patients,
      generalNotes,
      wardCondition,
      equipmentIssues,
      status
    } = req.body;

    const currentShift = getCurrentShift();
    const nextShift = getNextShift(currentShift);

    // Validate incoming nurse exists (no strict shift check — allows manual override)
    if (incomingNurseId) {
      const incomingNurse = await Staff.findById(incomingNurseId);
      if (!incomingNurse) {
        return res.status(404).json({ error: 'Selected incoming nurse not found' });
      }
    }

    const handover = new ShiftHandover({
      handoverDate: new Date(),
      outgoingShift: currentShift,
      incomingShift: nextShift,
      outgoingNurse: outgoingNurseId,
      incomingNurse: incomingNurseId || null,
      autoAssigned: !incomingNurseId,
      patients: patients || [],
      generalNotes: generalNotes || '',
      wardCondition: wardCondition || '',
      equipmentIssues: equipmentIssues || '',
      status: status || 'Draft'
    });

    // If auto-assign, find best nurse
    if (!incomingNurseId) {
      const nextShiftDoc = await findShiftDoc(nextShift);
      if (nextShiftDoc) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const candidates = await Staff.find({
          role: { $regex: /nurse/i },
          shift: nextShiftDoc._id,
          _id: { $ne: outgoingNurseId }
        });

        if (candidates.length > 0) {
          // Workload-based assignment
          let bestNurse = candidates[0];
          let minHandovers = Infinity;

          for (const nurse of candidates) {
            const count = await ShiftHandover.countDocuments({
              incomingNurse: nurse._id,
              status: { $in: ['Submitted', 'Draft'] },
              handoverDate: { $gte: today }
            });
            if (count < minHandovers) {
              minHandovers = count;
              bestNurse = nurse;
            }
          }

          handover.incomingNurse = bestNurse._id;
          handover.autoAssigned = true;
        }
      }
    }

    await handover.save();

    // Populate for response
    const populated = await ShiftHandover.findById(handover._id)
      .populate('outgoingNurse', 'first_name last_name')
      .populate('incomingNurse', 'first_name last_name');

    // If submitted, also create a nursing note for each patient
    if (status === 'Submitted') {
      for (const p of (patients || [])) {
        // Resolve patientId from the admission
        const IPDAdmission = require('../models/IPDAdmission');
        const admission = await IPDAdmission.findById(p.admissionId);
        
        const nursingNote = new NursingNote({
          admissionId: p.admissionId,
          patientId: admission ? admission.patientId : null,
          nurseId: outgoingNurseId,
          noteType: 'Handover',
          note: `ISBAR Handover: Condition - ${p.isbar?.situation?.currentCondition || 'Stable'}. ${p.isbar?.recommendation?.pendingTasks || ''}`,
          priority: p.isbar?.situation?.currentCondition === 'Critical' ? 'Critical' : 'Normal',
          shift: currentShift,
          shiftHandoverFrom: outgoingNurseId,
          shiftHandoverTo: handover.incomingNurse
        });
        await nursingNote.save();
      }
    }

    res.status(201).json({
      success: true,
      message: status === 'Submitted' ? 'Shift handover submitted successfully' : 'Handover draft saved',
      handover: populated
    });
  } catch (err) {
    console.error('Error creating handover:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get handover history
 */
exports.getHandoverHistory = async (req, res) => {
  try {
    const { nurseId } = req.params;
    const { limit = 10 } = req.query;

    const handovers = await ShiftHandover.find({
      $or: [{ outgoingNurse: nurseId }, { incomingNurse: nurseId }]
    })
      .populate('outgoingNurse', 'first_name last_name')
      .populate('incomingNurse', 'first_name last_name')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, handovers });
  } catch (err) {
    console.error('Error fetching handover history:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Acknowledge handover (by incoming nurse)
 */
exports.acknowledgeHandover = async (req, res) => {
  try {
    const { id } = req.params;
    const { nurseId } = req.body;

    const handover = await ShiftHandover.findById(id);
    if (!handover) return res.status(404).json({ error: 'Handover not found' });

    if (handover.status === 'Acknowledged') {
      return res.status(400).json({ error: 'Handover already acknowledged' });
    }

    handover.status = 'Acknowledged';
    handover.acknowledgedAt = new Date();
    handover.acknowledgedBy = nurseId;
    await handover.save();

    res.json({ success: true, message: 'Handover acknowledged', handover });
  } catch (err) {
    console.error('Error acknowledging handover:', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get pending handovers for a nurse (incoming)
 */
exports.getPendingHandovers = async (req, res) => {
  try {
    const { nurseId } = req.params;

    const handovers = await ShiftHandover.find({
      incomingNurse: nurseId,
      status: 'Submitted'
    })
      .populate('outgoingNurse', 'first_name last_name')
      .populate('incomingNurse', 'first_name last_name')
      .sort({ createdAt: -1 });

    res.json({ success: true, handovers });
  } catch (err) {
    console.error('Error fetching pending handovers:', err);
    res.status(500).json({ error: err.message });
  }
};