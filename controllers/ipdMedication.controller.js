const IPDMedicationChart = require('../models/IPDMedicationChart');
const IPDAdmission = require('../models/IPDAdmission');
const NursingNote = require('../models/NursingNote');
const IPDCharge = require('../models/IPDCharge');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const Pharmacy = require('../models/Pharmacy');

// ========== MEDICATION CHART ==========

// Create medication order (from Doctor Round)
exports.createMedicationOrder = async (req, res) => {
  try {
    const {
      admissionId,
      patientId,
      prescribedBy,
      roundId,
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
      requiresDoubleVerification,
      requiresPharmacyDispense
    } = req.body;

    // Verify admission exists
    const admission = await IPDAdmission.findById(admissionId);
    if (!admission) {
      return res.status(404).json({ error: 'Admission not found' });
    }

    // Get medicine details and cost from pharmacy database
    let costPerUnit = 0;
    let medicineDetails = null;
    
    if (medicineId) {
      medicineDetails = await Medicine.findById(medicineId);
      if (medicineDetails) {
        costPerUnit = medicineDetails.selling_price || medicineDetails.mrp || 0;
      }
    }

    const medication = new IPDMedicationChart({
      admissionId,
      patientId,
      prescribedBy,
      roundId: roundId || null,
      medicineId: medicineId || null,
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
      requiresPharmacyDispense: requiresPharmacyDispense || false,
      costPerUnit,
      status: requiresPharmacyDispense ? 'Pending' : 'Active',
      createdBy: req.user?._id
    });

    await medication.save();

    // If requires pharmacy dispense, create pharmacy request
    if (requiresPharmacyDispense) {
      await createPharmacyRequest(medication);
    }

    // Create nursing note for new medication order
    const nursingNote = new NursingNote({
      admissionId,
      patientId,
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

// Helper function to create pharmacy request
async function createPharmacyRequest(medication) {
  try {
    // Find in-house pharmacy
    const pharmacy = await Pharmacy.findOne({ status: 'Active' });
    if (!pharmacy) {
      console.log('No active pharmacy found for medication request');
      return;
    }

    const requestNumber = `PHARM-REQ-${Date.now()}-${medication._id}`;
    
    medication.pharmacyRequest = {
      requestedToPharmacy: true,
      requestedAt: new Date(),
      requestedBy: medication.createdBy,
      pharmacyId: pharmacy._id,
      pharmacyRequestNumber: requestNumber,
      pharmacyStatus: 'Pending'
    };
    
    medication.status = 'Requested';
    await medication.save();
    
  } catch (error) {
    console.error('Error creating pharmacy request:', error);
  }
}

// Get medications by admission
exports.getMedicationsByAdmission = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { status } = req.query;

    const filter = { admissionId };
    if (status) filter.status = status;

    const medications = await IPDMedicationChart.find(filter)
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name selling_price mrp')
      .populate('pharmacyRequest.pharmacyId', 'name')
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
      .populate('medicineId', 'medicine_name selling_price mrp')
      .populate('pharmacyRequest.pharmacyId', 'name')
      .populate('pharmacyRequest.dispensedBatchId', 'batch_number expiry_date');

    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }

    res.json({ success: true, medication });
  } catch (err) {
    console.error('Error fetching medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== PHARMACY INTEGRATION ==========

// Pharmacy: Get pending medication requests
exports.getPendingPharmacyRequests = async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    
    const medications = await IPDMedicationChart.find({
      'pharmacyRequest.requestedToPharmacy': true,
      'pharmacyRequest.pharmacyId': pharmacyId,
      'pharmacyRequest.pharmacyStatus': 'Pending'
    })
      .populate('admissionId', 'admissionNumber')
      .populate('patientId', 'first_name last_name patientId')
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name');

    res.json({ success: true, requests: medications });
  } catch (err) {
    console.error('Error fetching pharmacy requests:', err);
    res.status(500).json({ error: err.message });
  }
};

// Pharmacy: Process medication request (Approve/Reject)
exports.processPharmacyRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, batchId, dispensedQuantity, notes } = req.body;
    
    const medication = await IPDMedicationChart.findById(id);
    if (!medication) {
      return res.status(404).json({ error: 'Medication not found' });
    }
    
    if (action === 'approve') {
      // Check batch availability
      if (batchId) {
        const batch = await MedicineBatch.findById(batchId);
        if (!batch) {
          return res.status(404).json({ error: 'Batch not found' });
        }
        
        if (batch.quantity < (dispensedQuantity || 1)) {
          return res.status(400).json({ error: 'Insufficient stock in batch' });
        }
        
        // Deduct from batch
        batch.quantity -= (dispensedQuantity || 1);
        await batch.save();
        
        // Update medicine total stock
        await Medicine.findByIdAndUpdate(
          medication.medicineId,
          { $inc: { stock_quantity: -(dispensedQuantity || 1) } }
        );
        
        medication.pharmacyRequest.dispensedBatchId = batchId;
        medication.pharmacyRequest.dispensedQuantity = dispensedQuantity || 1;
        medication.pharmacyRequest.dispensedAt = new Date();
        medication.pharmacyRequest.dispensedFromPharmacy = true;
      }
      
      medication.pharmacyRequest.pharmacyStatus = 'Approved';
      medication.status = 'Active';
      
    } else if (action === 'reject') {
      medication.pharmacyRequest.pharmacyStatus = 'Rejected';
      medication.status = 'Stopped';
      medication.stoppedReason = `Pharmacy rejected: ${notes || 'Stock not available'}`;
      
    } else if (action === 'out_of_stock') {
      medication.pharmacyRequest.pharmacyStatus = 'OutOfStock';
      medication.pharmacyRequest.pharmacyNotes = notes;
    }
    
    if (notes) {
      medication.pharmacyRequest.pharmacyNotes = notes;
    }
    
    await medication.save();
    
    // Create nursing note
    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      noteType: 'Medication',
      note: `Pharmacy ${action}ed medication: ${medication.medicineName}. ${notes || ''}`,
      priority: 'Normal',
      createdBy: req.user?._id
    });
    await nursingNote.save();
    
    res.json({
      success: true,
      message: `Pharmacy request ${action}d successfully`,
      medication
    });
  } catch (err) {
    console.error('Error processing pharmacy request:', err);
    res.status(500).json({ error: err.message });
  }
};

// ========== MEDICATION ADMINISTRATION (NURSE) ==========

// Get today's medication schedule for nurse
exports.getNurseTodaySchedule = async (req, res) => {
  try {
    const nurseId = req.user?._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Get admissions in nurse's ward
    const admissions = await IPDAdmission.find({
      status: { $in: ['Admitted', 'Under Treatment'] }
    }).select('_id');
    
    const admissionIds = admissions.map(a => a._id);
    
    const medications = await IPDMedicationChart.find({
      admissionId: { $in: admissionIds },
      status: 'Active',
      startDate: { $lte: tomorrow },
      $or: [
        { endDate: { $gte: today } },
        { endDate: { $exists: false } }
      ]
    })
      .populate('admissionId', 'admissionNumber bedId')
      .populate('patientId', 'first_name last_name patientId')
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name');
    
    // Filter today's timings
    const todaySchedule = medications.map(med => {
      const todaysTimings = (med.timing || []).filter(t => {
        const timingDate = new Date(t.time);
        return timingDate >= today && timingDate < tomorrow && t.status === 'Pending';
      });
      
      return {
        ...med.toObject(),
        todaysTimings,
        pendingCount: todaysTimings.length
      };
    }).filter(med => med.todaysTimings.length > 0);
    
    res.json({ success: true, schedule: todaySchedule });
  } catch (err) {
    console.error('Error fetching nurse schedule:', err);
    res.status(500).json({ error: err.message });
  }
};

// Get medication schedule for specific admission (nurse view)
exports.getMedicationScheduleForNurse = async (req, res) => {
  try {
    const { admissionId } = req.params;
    const { date } = req.query;
    
    let targetDate = new Date();
    if (date) {
      targetDate = new Date(date);
    }
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);
    
    const medications = await IPDMedicationChart.find({
      admissionId,
      status: 'Active',
      startDate: { $lte: nextDate },
      $or: [
        { endDate: { $gte: targetDate } },
        { endDate: { $exists: false } }
      ]
    })
      .populate('prescribedBy', 'firstName lastName')
      .populate('medicineId', 'medicine_name');
    
    const schedule = medications.map(med => {
      const todaysTimings = (med.timing || []).filter(t => {
        const timingDate = new Date(t.time);
        return timingDate >= targetDate && timingDate < nextDate;
      });
      
      return {
        ...med.toObject(),
        todaysTimings,
        administeredCount: todaysTimings.filter(t => t.status === 'Administered').length,
        pendingCount: todaysTimings.filter(t => t.status === 'Pending').length
      };
    }).filter(med => med.todaysTimings.length > 0);
    
    res.json({ success: true, schedule, date: targetDate });
  } catch (err) {
    console.error('Error fetching medication schedule:', err);
    res.status(500).json({ error: err.message });
  }
};

// Administer medication (Nurse action)
exports.administerMedication = async (req, res) => {
  try {
    const { id } = req.params;
    const { timingId, remarks, witnessedBy } = req.body;

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
    medication.timing[timingIndex].administeredBy = req.user?._id;
    medication.timing[timingIndex].remarks = remarks;
    
    if (witnessedBy) {
      medication.timing[timingIndex].witnessedBy = witnessedBy;
    }

    // Check if all timings are completed
    const allCompleted = medication.timing.every(t => 
      t.status === 'Administered' || t.status === 'Skipped' || t.status === 'Held'
    );
    
    if (allCompleted) {
      medication.status = 'Completed';
    }

    await medication.save();

    // Create billing charge for administered medication
    if (!medication.isBilled && medication.costPerUnit > 0) {
      const charge = new IPDCharge({
        admissionId: medication.admissionId,
        patientId: medication.patientId,
        chargeType: 'Pharmacy',
        description: `Medication: ${medication.medicineName} ${medication.dosage}`,
        quantity: 1,
        rate: medication.costPerUnit,
        amount: medication.costPerUnit,
        sourceModule: 'Pharmacy',
        sourceId: medication._id,
        isAutoGenerated: true,
        addedBy: req.user?._id
      });
      await charge.save();
      
      medication.isBilled = true;
      await medication.save();
    }

    // Create nursing note for administration
    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id,
      noteType: 'Medication',
      note: `Medication administered: ${medication.medicineName} ${medication.dosage}. ${remarks || ''}`,
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

// Skip medication (Nurse action)
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

// Hold medication (Nurse action)
exports.holdMedication = async (req, res) => {
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

    medication.timing[timingIndex].status = 'Held';
    medication.timing[timingIndex].remarks = remarks;
    await medication.save();

    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
      nurseId: req.user?._id,
      noteType: 'Medication',
      note: `Medication held: ${medication.medicineName}. Reason: ${remarks || 'Not specified'}`,
      priority: 'Important',
      createdBy: req.user?._id
    });
    await nursingNote.save();

    res.json({
      success: true,
      message: 'Medication held',
      medication
    });
  } catch (err) {
    console.error('Error holding medication:', err);
    res.status(500).json({ error: err.message });
  }
};

// Stop medication order (Doctor action)
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

    const nursingNote = new NursingNote({
      admissionId: medication.admissionId,
      patientId: medication.patientId,
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

// Get medication schedule for today (admission specific)
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

    const todaySchedule = medications.map(med => ({
      ...med.toObject(),
      todaysTimings: (med.timing || []).filter(t => {
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

// Get medication administration summary for admission
exports.getMedicationSummary = async (req, res) => {
  try {
    const { admissionId } = req.params;
    
    const medications = await IPDMedicationChart.find({ admissionId });
    
    const summary = {
      total: medications.length,
      active: medications.filter(m => m.status === 'Active').length,
      completed: medications.filter(m => m.status === 'Completed').length,
      stopped: medications.filter(m => m.status === 'Stopped').length,
      pendingPharmacy: medications.filter(m => m.pharmacyRequest?.pharmacyStatus === 'Pending').length,
      totalDosesAdministered: 0,
      totalDosesSkipped: 0,
      totalDosesHeld: 0,
      totalCost: 0
    };
    
    medications.forEach(med => {
      summary.totalDosesAdministered += (med.timing || []).filter(t => t.status === 'Administered').length;
      summary.totalDosesSkipped += (med.timing || []).filter(t => t.status === 'Skipped').length;
      summary.totalDosesHeld += (med.timing || []).filter(t => t.status === 'Held').length;
      summary.totalCost += med.totalCost || 0;
    });
    
    res.json({ success: true, summary });
  } catch (err) {
    console.error('Error fetching medication summary:', err);
    res.status(500).json({ error: err.message });
  }
};