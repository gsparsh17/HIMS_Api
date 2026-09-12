const Shift = require('../models/Shift');
const Staff = require('../models/Staff');
const ShiftHandover = require('../models/ShiftHandover');
const IPDAdmission = require('../models/IPDAdmission');
const NursingNote = require('../models/NursingNote');
const IPDVitals = require('../models/IPDVitals');
const Hospital = require('../models/Hospital');
const HRStaffProfile = require('../models/HRStaffProfile');
const staffScheduleService = require('../services/staffSchedule.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { DEFAULT_HOSPITAL_TIME_ZONE, hospitalTimeParts, hospitalDateKey, hospitalDayBounds, parseHospitalDateTime, addDateKeyDays } = require('../utils/hospitalDateTime');

// ========== BASIC SHIFT CRUD ==========

exports.createShift = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const shift = new Shift({ ...req.body, hospitalId });
    await shift.save();
    res.status(201).json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getAllShifts = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    let shifts = await Shift.find({ hospitalId, is_active: { $ne: false } }).sort({ start_time: 1 });
    // Migration compatibility: if this hospital has not yet received scoped shifts,
    // clone the familiar defaults rather than using another hospital's records.
    if (shifts.length === 0) {
      const defaultShifts = [
        { hospitalId, name: 'Morning', start_time: '07:00', end_time: '15:00', spans_next_day: false },
        { hospitalId, name: 'Evening', start_time: '15:00', end_time: '23:00', spans_next_day: false },
        { hospitalId, name: 'Night', start_time: '23:00', end_time: '07:00', spans_next_day: true }
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
    const hospitalId = requireHospitalId(req);
    const shift = await Shift.findOneAndUpdate({ _id: req.params.id, hospitalId, is_active: { $ne: false } }, req.body, { new: true, runValidators: true });
    res.json(shift);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.deleteShift = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const shift = await Shift.findOneAndUpdate(
      { _id: req.params.id, hospitalId, is_active: { $ne: false } },
      { $set: { is_active: false, deleted_at: new Date(), deleted_by: req.user?._id || null, deletion_reason: String(req.body?.reason || 'Shift archived by user').trim() } },
      { new: true }
    );
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json({ message: 'Shift archived successfully', shift });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getShiftById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const shift = await Shift.findOne({ _id: req.params.id, hospitalId, is_active: { $ne: false } });
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ========== SHIFT HANDOVER SYSTEM ==========

/** Resolve current/next named shift in the hospital timezone. */
function wallMinutes(value) {
  const [hour, minute] = String(value || '00:00').slice(0, 5).split(':').map(Number);
  return hour * 60 + minute;
}

function shiftContainsMinutes(shift, minute) {
  const start = wallMinutes(shift.start_time);
  const end = wallMinutes(shift.end_time);
  const spans = Boolean(shift.spans_next_day) || end <= start;
  return spans ? (minute >= start || minute < end) : (minute >= start && minute < end);
}

async function getShiftContext(req) {
  const hospitalId = requireHospitalId(req);
  const hospital = await Hospital.findById(hospitalId).select('timezone').lean();
  const timeZone = hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  let shifts = await Shift.find({ hospitalId, is_active: { $ne: false } }).sort({ start_time: 1 }).lean();
  if (!shifts.length) {
    shifts = [
      { name: 'Morning', start_time: '07:00', end_time: '15:00' },
      { name: 'Evening', start_time: '15:00', end_time: '23:00' },
      { name: 'Night', start_time: '23:00', end_time: '07:00', spans_next_day: true }
    ];
  }
  const now = hospitalTimeParts(new Date(), timeZone);
  const minute = Number(now.hour) * 60 + Number(now.minute);
  const current = shifts.find((shift) => shiftContainsMinutes(shift, minute)) || shifts[0];
  const ordered = [...shifts].sort((a, b) => wallMinutes(a.start_time) - wallMinutes(b.start_time));
  const currentIndex = ordered.findIndex((shift) => String(shift._id || shift.name) === String(current?._id || current?.name));
  const next = ordered[(currentIndex + 1 + ordered.length) % ordered.length] || current;
  return { hospitalId, timeZone, current, next, shifts };
}

const findShiftDoc = async (hospitalId, shiftName) => Shift.findOne({
  hospitalId,
  is_active: { $ne: false },
  name: { $regex: new RegExp(`^${shiftName}$`, 'i') }
});

function nextShiftStartInstant(shiftContext) {
  const now = new Date();
  const parts = hospitalTimeParts(now, shiftContext.timeZone);
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute);
  const nextStartMinute = wallMinutes(shiftContext.next?.start_time || '00:00');
  let dateKey = hospitalDateKey(now, shiftContext.timeZone);
  if (nextStartMinute <= currentMinute) dateKey = addDateKeyDays(dateKey, 1);
  return parseHospitalDateTime(shiftContext.next?.start_time || '00:00', dateKey, shiftContext.timeZone);
}

async function staffProfileMapForStaff({ hospitalId, staffRows }) {
  const ids = staffRows.map((row) => row._id).filter(Boolean);
  if (!ids.length) return new Map();
  const profiles = await HRStaffProfile.find({
    hospital_id: hospitalId,
    is_active: { $ne: false },
    $or: [
      { staff_id: { $in: ids } },
      { source_model: 'Staff', source_id: { $in: ids } }
    ]
  }).select('_id staff_id source_id').lean();
  const map = new Map();
  for (const profile of profiles) {
    if (profile.staff_id) map.set(String(profile.staff_id), profile);
    if (profile.source_id) map.set(String(profile.source_id), profile);
  }
  return map;
}

async function nurseMatchesIncomingSchedule({ nurse, profile, shiftContext, nextShiftDoc, targetInstant }) {
  if (profile?._id) {
    try {
      const scheduled = await staffScheduleService.isEmployeeScheduledAt({
        hospitalId: shiftContext.hospitalId,
        employeeId: profile._id,
        instant: targetInstant
      });
      // When a weekly schedule is configured, it is authoritative. If it is not configured,
      // preserve legacy single-shift behaviour below.
      const schedule = await staffScheduleService.getEmployeeScheduleIntervals({
        hospitalId: shiftContext.hospitalId,
        employeeId: profile._id,
        dateKey: hospitalDateKey(targetInstant, shiftContext.timeZone),
        timeZone: shiftContext.timeZone
      });
      if (schedule.scheduleSource !== 'unconfigured') return scheduled;
    } catch (error) {
      console.warn('Nurse schedule resolution warning:', error.message);
    }
  }
  return Boolean(nextShiftDoc && nurse.shift && String(nurse.shift._id || nurse.shift) === String(nextShiftDoc._id));
}

/**
 * Auto-assign incoming nurse based on:
 * 1. The nurse must be assigned to the next shift
 * 2. The nurse must have the fewest active handovers (workload balancing)
 * 3. Exclude the outgoing nurse
 */
exports.getAvailableNursesForHandover = async (req, res) => {
  try {
    const { outgoingNurseId } = req.params;
    const shiftContext = await getShiftContext(req);
    const currentShift = shiftContext.current?.name || 'Current';
    const nextShiftName = shiftContext.next?.name || currentShift;
    const nextShiftDoc = shiftContext.next?._id ? await Shift.findById(shiftContext.next._id) : null;

    // Fetch ALL hospital nurses (except outgoing) so user has full visibility
    const availableNurses = await Staff.find({
      hospitalId: shiftContext.hospitalId,
      role: { $regex: /nurse/i },
      _id: { $ne: outgoingNurseId }
    }).populate('shift', 'name start_time end_time')
      .populate('department', 'name');

    // Count active (unacknowledged) handovers per nurse to determine workload
    const todayKey = hospitalDateKey(new Date(), shiftContext.timeZone);
    const { start: today } = hospitalDayBounds(todayKey, shiftContext.timeZone);

    const profileMap = await staffProfileMapForStaff({ hospitalId: shiftContext.hospitalId, staffRows: availableNurses });
    const targetInstant = nextShiftStartInstant(shiftContext);
    const nurseWorkloads = await Promise.all(
      availableNurses.map(async (nurse) => {
        const activeHandovers = await ShiftHandover.countDocuments({
          incomingNurse: nurse._id,
          status: { $in: ['Submitted', 'Draft'] },
          handoverDate: { $gte: today }
        });
        const isNextShift = await nurseMatchesIncomingSchedule({
          nurse,
          profile: profileMap.get(String(nurse._id)),
          shiftContext,
          nextShiftDoc,
          targetInstant
        });

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
    const hospitalId = requireHospitalId(req);
    // Get all active admissions for this hospital only.
    const admissions = await IPDAdmission.find({
      hospitalId,
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
      currentShift: (await getShiftContext(req)).current?.name || '',
      nextShift: (await getShiftContext(req)).next?.name || ''
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

    const shiftContext = await getShiftContext(req);
    const currentShift = shiftContext.current?.name || 'Current';
    const nextShift = shiftContext.next?.name || currentShift;

    // Validate incoming nurse exists (no strict shift check — allows manual override)
    if (incomingNurseId) {
      const incomingNurse = await Staff.findOne({ _id: incomingNurseId, hospitalId: shiftContext.hospitalId, is_active: { $ne: false } });
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
      const nextShiftDoc = await findShiftDoc(shiftContext.hospitalId, nextShift);
      if (nextShiftDoc) {
        const todayKey = hospitalDateKey(new Date(), shiftContext.timeZone);
        const { start: today } = hospitalDayBounds(todayKey, shiftContext.timeZone);
        const allCandidates = await Staff.find({
          hospitalId: shiftContext.hospitalId,
          role: { $regex: /nurse/i },
          _id: { $ne: outgoingNurseId }
        }).populate('shift', 'name start_time end_time');
        const profileMap = await staffProfileMapForStaff({ hospitalId: shiftContext.hospitalId, staffRows: allCandidates });
        const targetInstant = nextShiftStartInstant(shiftContext);
        const candidates = [];
        for (const nurse of allCandidates) {
          if (await nurseMatchesIncomingSchedule({
            nurse,
            profile: profileMap.get(String(nurse._id)),
            shiftContext,
            nextShiftDoc,
            targetInstant
          })) candidates.push(nurse);
        }

        if (candidates.length > 0) {
          // Workload-based assignment among nurses who are actually scheduled for the incoming period.
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

/**
 * Get current acknowledged handovers for a nurse
 */
exports.getCurrentHandovers = async (req, res) => {
  try {
    const { nurseId } = req.params;

    // Only get handovers from the last 24 hours to avoid clutter
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const handovers = await ShiftHandover.find({
      incomingNurse: nurseId,
      status: 'Acknowledged',
      handoverDate: { $gte: yesterday }
    })
      .populate('outgoingNurse', 'first_name last_name')
      .populate('incomingNurse', 'first_name last_name')
      .sort({ acknowledgedAt: -1, createdAt: -1 });

    res.json({ success: true, handovers });
  } catch (err) {
    console.error('Error fetching current handovers:', err);
    res.status(500).json({ error: err.message });
  }
};