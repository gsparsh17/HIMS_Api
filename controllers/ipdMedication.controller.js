const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const NursingNote = require('../models/NursingNote');
const IPDCharge = require('../models/IPDCharge');

// ========== MEDICATION CHART ==========

// Create medication order
exports.createMedicationOrder = async (req, res) => {
  try {
    const {
      admissionId,
      patientId,
      prescribedBy,
      medicineId,
      medicineName,
      genericName,
      route,
      dosage,
      frequency,
      startDate,
      endDate,
      duration,
      durationUnit,
      specialInstructions,
      isHighRisk,
      requiresDoubleVerification
    } = req.body;

    // Verify admission exists
    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    const medication = new IPDMedicationChart({
      admissionId,
      patientId,
      prescribedBy,
      medicineId,
      medicineName,
      genericName,
      route,
      dosage,
      frequency,
      startDate: startDate || new Date(),
      endDate,
      duration: duration || 1,
      durationUnit,
      specialInstructions,
      isHighRisk: isHighRisk || false,
      requiresDoubleVerification: requiresDoubleVerification || false,
      status: 'Active',
      createdBy: req.user?._id
    });

    await medication.save();

    // Create nursing note for new medication order
    const nursingNote = new NursingNote({
      admissionId,
      patientId,
      nurseId: null,
      noteType: 'Medication',
      note: `New medication ordered: ${medicineName} ${dosage} ${route} ${frequency}`,
      priority: isHighRisk ? 'Important' : 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.status(201).json({
      success: true,
      message: 'Medication order created successfully',
      medication
    });
  } catch (err) {
    console.error('Error creating medication order:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medications by admission
exports.getMedicationsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { status } = req.query;

    const filter = { admissionId };
    if (status) filter.status = status;

    const medications = await IPDMedicationChart.find(filter)
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name')
      .sort({ startDate: -1 });

    res.json({ success: true, medications });
  } catch (err) {
    console.error('Error fetching medications:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medication by ID
exports.getMedicationById = async (req, res) => {
  try {
    const { id } = req.params;

    const medication = await IPDMedicationChart.findById(id)
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name');

    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    res.json({ success: true, medication });
  } catch (err) {
    console.error('Error fetching medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Administer medication
exports.administerMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, administeredBy, remarks, witnessedBy } = req.body;

    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const timingIndex = medication.timing.findIndex(t => t._id.toString() === timingId);
    if (timingIndex === -1) {
      return res.status(404).json({ error: 'Timing not found' });
    }

    // For high-risk medications, require double verification
    if (medication.isHighRisk && medication.requiresDoubleVerification && !witnessedBy) {
      return res.status(400).json({ error: 'Double verification required for high-risk medication' });
    }

    medication.timing[timingIndex].status = 'Administered';
    medication.timing[timingIndex].administeredAt = new Date();
    medication.timing[timingIndex].administeredBy = administeredBy || req.user?._id;
    medication.timing[timingIndex].remarks = remarks;
    
    if (witnessedBy) {
      medication.timing[timingIndex].witnessedBy = witnessedBy;
    }

    await medication.save();

    // Create nursing note for administration
    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: administeredBy || req.user?._id,
      noteType: 'Medication',
      note: `Medication administered: ${medication.medicineName} ${medication.dosage}`,
      priority: medication.isHighRisk ? 'Important' : 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication administered successfully',
      medication
    });
  } catch (err) {
    console.error('Error administering medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Skip medication
exports.skipMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks } = req.body;

    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    const timingIndex = medication.timing.findIndex(t => t._id.toString() === timingId);
    if (timingIndex === -1) {
      return res.status(404).json({ error: 'Timing not found' });
    }

    medication.timing[timingIndex].status = 'Skipped';
    medication.timing[timingIndex].remarks = remarks;
    await medication.save();

    // Create nursing note for skipped medication
    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id,
      noteType: 'Medication',
      note: `Medication skipped: ${medication.medicineName}. Reason: ${remarks || 'Not specified'}`,
      priority: 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication skipped',
      medication
    });
  } catch (err) {
    console.error('Error skipping medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Stop medication order
exports.stopMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { stoppedReason } = req.body;

    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    medication.status = 'Stopped';
    medication.stoppedReason = stoppedReason;
    medication.stoppedBy = req.user?._id;
    medication.endDate = new Date();
    await medication.save();

    // Create nursing note for stopped medication
    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: null,
      noteType: 'Medication',
      note: `Medication stopped: ${medication.medicineName}. Reason: ${stoppedReason}`,
      priority: 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication stopped successfully',
      medication
    });
  } catch (err) {
    console.error('Error stopping medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medication schedule for today
exports.getTodaySchedule = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const medications = await IPDMedicationChart.find({
      admissionId,
      status: 'Active',
      startDate: { $lte: tomorrow },
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false } }
      ]
    }).populate('prescribedBy', 'firstName lastName');

    // Filter today's timings
    const todaySchedule = medications.map(med => ({
      ...med.toObject(),
      todaysTimings: med.timing.filter(t => {
        const timingDate = new Date(t.time);
        return timingDate >= today && timingDate < tomorrow;
      })
    })).filter(med => med.todaysTimings.length > 0);

    res.json({ success: true, schedule: todaySchedule });
  } catch (err) {
    console.error('Error fetching today\'s schedule:', err);
    res.status(500).json({ error: err.message });
  }
};