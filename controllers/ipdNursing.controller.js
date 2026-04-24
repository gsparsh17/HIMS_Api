const NursingNote = require('../models/NursingNote');
const IPDVitals = require('../models/IPDVitals');
const IPDAdmission = require('../models/IPDAdmission');
const IPDMedicationChart = require('../models/IPDMedicationChart');
const Patient = require('../models/Patient');

// ========== NURSING NOTES ==========

// Create nursing note
exports.createNursingNote = async (req, res) => {
  try {
    const {
      admissionId,
      patientId,
      nurseId,
      noteDateTime,
      noteType,
      note,
      priority,
      shift,
      shiftHandoverFrom,
      shiftHandoverTo,
      attachments
    } = req.body;

    // Verify admission exists
    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const nursingNote = new NursingNote({
      admissionId,
      patientId,
      nurseId: nurseId || req.user?._id,
      noteDateTime: noteDateTime || new Date(),
      noteType,
      note,
      priority,
      shift,
      shiftHandoverFrom,
      shiftHandoverTo,
      attachments,
      createdBy: req.user?._id
    });

    await nursingNote.save();

    res.status(201).json({
      success: true,
      message: 'Nursing note added successfully',
      nursingNote
    });
  } catch (err) {
    console.error('Error creating nursing note:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get nursing notes by admission
exports.getNursingNotesByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { limit = 50, noteType } = req.query;

    const filter = { admissionId };
    if (noteType) filter.noteType = noteType;

    const nursingNotes = await NursingNote.find(filter)
      .populate('nurseId', 'first_name last_name')
      .populate('shiftHandoverFrom', 'first_name last_name')
      .populate('shiftHandoverTo', 'first_name last_name')
      .sort({ noteDateTime: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, nursingNotes });
  } catch (err) {
    console.error('Error fetching nursing notes:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get nursing note by ID
exports.getNursingNoteById = async (req, res) => {
  try {
    const { id } = req.params;

    const nursingNote = await NursingNote.findById(id)
      .populate('nurseId', 'first_name last_name')
      .populate('shiftHandoverFrom', 'first_name last_name')
      .populate('shiftHandoverTo', 'first_name last_name');

    if (!nursingNote) {
      return res.status(404).json({ error: 'Nursing note not found' });
    }

    res.json({ success: true, nursingNote });
  } catch (err) {
    console.error('Error fetching nursing note:', err);
    res.status(500).json({ error: err.message });
  }
};

// Update nursing note
exports.updateNursingNote = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const nursingNote = await NursingNote.findByIdAndUpdate(id, updates, { new: true });
    if (!nursingNote) {
      return res.status(404).json({ error: 'Nursing note not found' });
    }

    res.json({
      success: true,
      message: 'Nursing note updated successfully',
      nursingNote
    });
  } catch (err) {
    console.error('Error updating nursing note:', err);
    res.status(500).json({ error: err.message });
  }
};

// Delete nursing note
exports.deleteNursingNote = async (req, res) => {
  try {
    const { id } = req.params;

    const nursingNote = await NursingNote.findByIdAndDelete(id);
    if (!nursingNote) {
      return res.status(404).json({ error: 'Nursing note not found' });
    }

    res.json({
      success: true,
      message: 'Nursing note deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting nursing note:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== IPD VITALS ==========

// Create vitals record
exports.createVitals = async (req, res) => {
  try {
    const {
      admissionId,
      patientId,
      recordedBy,
      recordedAt,
      temperature,
      temperatureUnit,
      pulse,
      bloodPressure,
      respiratoryRate,
      spo2,
      bloodSugar,
      weight,
      height,
      painScore,
      glasgowComaScale,
      intakeOutput,
      remarks
    } = req.body;

    // Verify admission exists
    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const vitals = new IPDVitals({
      admissionId,
      patientId,
      recordedBy: recordedBy || req.user?._id,
      recordedAt: recordedAt || new Date(),
      temperature,
      temperatureUnit,
      pulse,
      bloodPressure,
      respiratoryRate,
      spo2,
      bloodSugar,
      weight,
      height,
      painScore,
      glasgowComaScale,
      intakeOutput,
      remarks
    });

    await vitals.save();

    // Check for critical values and create alert
    if (vitals.isAbnormal) {
      // Create nursing note for abnormal vitals
      const alertNote = new NursingNote({
        admissionId,
        patientId,
        nurseId: req.user?._id,
        noteType: 'Critical Alert',
        note: `Abnormal vitals recorded: ${vitals.isAbnormal ? 'Multiple parameters outside normal range' : ''}`,
        priority: 'Critical',
        createdBy: req.user?._id
      });
      await alertNote.save();
    }

    res.status(201).json({
      success: true,
      message: 'Vitals recorded successfully',
      vitals
    });
  } catch (err) {
    console.error('Error recording vitals:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get vitals by admission
exports.getVitalsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { limit = 50, startDate, endDate } = req.query;

    const filter = { admissionId };
    if (startDate && endDate) {
      filter.recordedAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    const vitals = await IPDVitals.find(filter)
      .populate('recordedBy', 'first_name last_name')
      .sort({ recordedAt: -1 })
      .limit(parseInt(limit));

    // Get latest vitals for trending
    const latestVitals = vitals[0] || null;

    res.json({
      success: true,
      vitals,
      latestVitals,
      count: vitals.length
    });
  } catch (err) {
    console.error('Error fetching vitals:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get vitals chart data
exports.getVitalsChartData = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { days = 7 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const vitals = await IPDVitals.find({
      admissionId,
      recordedAt: { $gte: startDate }
    }).sort({ recordedAt: 1 });

    // Format data for charts
    const chartData = {
      dates: [],
      temperature: [],
      pulse: [],
      bloodPressureSystolic: [],
      bloodPressureDiastolic: [],
      respiratoryRate: [],
      spo2: [],
      bloodSugar: []
    };

    vitals.forEach(v => {
      chartData.dates.push(v.recordedAt.toISOString().split('T')[0]);
      chartData.temperature.push(v.temperature || null);
      chartData.pulse.push(v.pulse || null);
      chartData.bloodPressureSystolic.push(v.bloodPressure?.systolic || null);
      chartData.bloodPressureDiastolic.push(v.bloodPressure?.diastolic || null);
      chartData.respiratoryRate.push(v.respiratoryRate || null);
      chartData.spo2.push(v.spo2 || null);
      chartData.bloodSugar.push(v.bloodSugar || null);
    });

    res.json({ success: true, chartData });
  } catch (err) {
    console.error('Error fetching vitals chart data:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get latest vitals by admission
exports.getLatestVitals = async (req, res) => {
  try {
    const { admissionId } = req.params;

    const latestVitals = await IPDVitals.findOne({ admissionId })
      .sort({ recordedAt: -1 })
      .populate('recordedBy', 'first_name last_name');

    res.json({ success: true, latestVitals });
  } catch (err) {
    console.error('Error fetching latest vitals:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== NURSE ASSIGNMENT ==========

// Get nurses by ward
exports.getNursesByWard = async (req, res) => {
  try {
    const { wardId } = req.params;
    
    const nurses = await Nurse.find({ 
      assignedWard: wardId,
      isActive: true 
    }).select('first_name last_name employeeId');

    res.json({ success: true, nurses });
  } catch (err) {
    console.error('Error fetching nurses by ward:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get assigned patients for nurse
exports.getAssignedPatients = async (req, res) => {
  try {
    const nurseId = req.user?._id;
    
    // Get admissions in wards where nurse is assigned
    const admissions = await IPDAdmission.find({
      status: { $in: ['Admitted', 'Under Treatment'] },
      wardId: { $in: await getNurseWards(nurseId) }
    })
      .populate('patientId', 'first_name last_name patientId phone')
      .populate('primaryDoctorId', 'firstName lastName')
      .populate('bedId', 'bedNumber bedType')
      .sort({ admissionDate: -1 });

    res.json({ success: true, patients: admissions });
  } catch (err) {
    console.error('Error fetching assigned patients:', err);
    res.status(500).json({ error: err.message });
  }
};