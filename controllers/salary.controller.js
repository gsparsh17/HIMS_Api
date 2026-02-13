const Salary = require('../models/Salary');
const Doctor = require('../models/Doctor');
const Appointment = require('../models/Appointment');
const mongoose = require('mongoose');

// -------------------- helpers --------------------
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const toNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const parseDateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

const addOverlapPeriodFilter = (filter, start, end) => {
  if (!start || !end) return filter;
  filter.period_start = { $lte: end };
  filter.period_end = { $gte: start };
  return filter;
};

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

const ALLOWED_SALARY_STATUSES = new Set(['pending', 'paid', 'cancelled', 'hold']);

// -------------------- NEW: Helper function to calculate revenue distribution --------------------
const calculateRevenueDistribution = (doctor, appointmentFees) => {
  const totalFees = toNumber(appointmentFees, 0);
  
  // Full-time doctors get 100% of their salary (already handled in monthly salary)
  if (doctor.isFullTime || ['Salary', 'Contractual Salary'].includes(doctor.paymentType)) {
    return {
      doctorAmount: 0, // They get salary, not per-appointment
      hospitalAmount: totalFees,
      percentage: 100, // Hospital gets all appointment fees
      isFullTime: true
    };
  }
  
  // Part-time doctors: apply revenue percentage
  const percentage = toNumber(doctor.revenuePercentage, 100);
  const doctorAmount = (totalFees * percentage) / 100;
  const hospitalAmount = totalFees - doctorAmount;
  
  return {
    doctorAmount,
    hospitalAmount,
    percentage,
    isFullTime: false
  };
};

// -------------------- UPDATED: Part-time salary calculation --------------------
exports.calculatePartTimeSalary = async (appointmentId) => {
  try {
    if (!isValidObjectId(appointmentId)) return null;

    const appointment = await Appointment.findById(appointmentId)
      .populate('doctor_id')
      .populate('patient_id');

    if (!appointment || appointment.status !== 'Completed') {
      return null;
    }

    const doctor = appointment.doctor_id;
    if (!doctor) return null;

    // Fixed salary doctors -> no per-visit calc
    if (['Salary', 'Contractual Salary'].includes(doctor.paymentType)) {
      return null;
    }

    const rate = toNumber(doctor.amount, 0);
    let appointmentFees = 0;

    let notes = `Appointment: ${appointment._id}, Patient: ${
      appointment.patient_id?.first_name || 'Unknown'
    }`;

    switch (doctor.paymentType) {
      case 'Fee per Visit':
        appointmentFees = rate;
        notes += `, Type: Per Visit`;
        break;

      case 'Per Hour': {
        const durationMin = toNumber(appointment.duration, 0);
        if (durationMin > 0) {
          const hours = durationMin / 60;
          appointmentFees = rate * hours;
          notes += `, Duration: ${durationMin}min, Rate: ₹${rate}/hr`;
        }
        break;
      }

      default:
        return null;
    }

    appointmentFees = toNumber(appointmentFees, 0);
    if (appointmentFees <= 0) return null;

    // Calculate revenue distribution
    const revenueDistribution = calculateRevenueDistribution(doctor, appointmentFees);
    
    // Only part-time doctors get per-appointment salary
    let doctorAmount = revenueDistribution.doctorAmount;
    
    notes += `, Total Fees: ₹${appointmentFees}, Doctor's Share: ${revenueDistribution.percentage}% (₹${doctorAmount.toFixed(2)})`;

    // ✅ FIX: book salary into the appointment's completion day
    const baseDate =
      appointment.actual_end_time ||
      appointment.updatedAt ||
      appointment.appointment_date ||
      new Date();

    const periodStart = startOfDay(new Date(baseDate));
    const periodEnd = endOfDay(new Date(baseDate));

    // Find existing daily salary for that doctor/day
    let salary = await Salary.findOne({
      doctor_id: doctor._id,
      period_type: 'daily',
      period_start: periodStart,
      period_end: periodEnd
    });

    if (salary) {
      // Check if this appointment is already accounted for
      if (salary.appointments && salary.appointments.includes(appointmentId)) {
        return salary;
      }

      salary.amount = toNumber(salary.amount, 0) + doctorAmount;
      salary.appointment_count = toNumber(salary.appointment_count, 0) + 1;
      
      // Initialize appointments array if it doesn't exist (migrations)
      if (!salary.appointments) {
        salary.appointments = [];
      }
      salary.appointments.push(appointmentId);

      salary.net_amount =
        toNumber(salary.amount, 0) +
        toNumber(salary.bonus, 0) -
        toNumber(salary.deductions, 0);

      salary.notes = salary.notes ? `${salary.notes} | ${notes}` : notes;
      await salary.save();
      return salary;
    }

    salary = new Salary({
      doctor_id: doctor._id,
      period_type: 'daily',
      period_start: periodStart,
      period_end: periodEnd,
      amount: doctorAmount,
      appointment_count: 1,
      appointments: [appointmentId], // Initialize with current appointment
      net_amount: doctorAmount,
      notes,
      status: 'pending'
    });

    await salary.save();
    return salary;
  } catch (error) {
    console.error('Error calculating part-time salary:', error);
    return null;
  }
};

// -------------------- NEW: Function to track hospital revenue --------------------
exports.trackHospitalRevenue = async (appointmentId) => {
  try {
    if (!isValidObjectId(appointmentId)) return null;

    const appointment = await Appointment.findById(appointmentId)
      .populate('doctor_id')
      .populate('patient_id');

    if (!appointment || appointment.status !== 'Completed') {
      return null;
    }

    const doctor = appointment.doctor_id;
    if (!doctor) return null;

    const rate = toNumber(doctor.amount, 0);
    let appointmentFees = 0;

    switch (doctor.paymentType) {
      case 'Fee per Visit':
        appointmentFees = rate;
        break;
      case 'Per Hour': {
        const durationMin = toNumber(appointment.duration, 0);
        if (durationMin > 0) {
          const hours = durationMin / 60;
          appointmentFees = rate * hours;
        }
        break;
      }
      case 'Salary':
      case 'Contractual Salary':
        // For salary doctors, hospital keeps all appointment fees
        appointmentFees = rate;
        break;
      default:
        return null;
    }

    appointmentFees = toNumber(appointmentFees, 0);
    if (appointmentFees <= 0) return null;

    // Calculate hospital's share
    let hospitalAmount = appointmentFees;
    
    if (!doctor.isFullTime && !['Salary', 'Contractual Salary'].includes(doctor.paymentType)) {
      const percentage = toNumber(doctor.revenuePercentage, 100);
      const doctorAmount = (appointmentFees * percentage) / 100;
      hospitalAmount = appointmentFees - doctorAmount;
    }
    
    return {
      totalFees: appointmentFees,
      hospitalShare: hospitalAmount,
      doctorShare: appointmentFees - hospitalAmount,
      percentage: doctor.isFullTime ? 0 : (100 - toNumber(doctor.revenuePercentage, 100))
    };
  } catch (error) {
    console.error('Error tracking hospital revenue:', error);
    return null;
  }
};

// -------------------- UPDATED: Bulk calculate with revenue distribution --------------------
exports.bulkCalculateAndPayPartTimeSalaries = async (req, res) => {
  try {
    const { periodType, startDate, endDate, payment_method, notes } = req.body;

    if (!['daily', 'weekly', 'monthly'].includes(periodType)) {
      return res.status(400).json({ error: 'Invalid period type. Use daily, weekly, or monthly.' });
    }

    const periodStart = parseDateOrNull(startDate);
    const periodEnd = parseDateOrNull(endDate);

    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }

    const partTimeDoctors = await Doctor.find({
      isFullTime: false,
      paymentType: { $in: ['Fee per Visit', 'Per Hour'] }
    });

    const results = [];
    let totalAmount = 0;
    let totalAppointments = 0;
    let totalHospitalRevenue = 0;

    for (const doctor of partTimeDoctors) {
      const appointments = await Appointment.find({
        doctor_id: doctor._id,
        status: 'Completed',
        actual_end_time: { $gte: periodStart, $lte: periodEnd }
      }).populate('patient_id');

      if (!appointments.length) {
        results.push({
          doctor: doctor._id,
          doctorName: `${doctor.firstName} ${doctor.lastName}`,
          status: 'no_appointments',
          amount: 0,
          appointments: 0,
          hospitalRevenue: 0
        });
        continue;
      }

      const rate = toNumber(doctor.amount, 0);
      let totalDoctorAmount = 0;
      let totalAppointmentFees = 0;

      let doctorNotes = `Bulk payment for ${periodType} period: ${startDate} to ${endDate}. Appointments: `;

      for (const appt of appointments) {
        let appointmentFees = 0;

        if (doctor.paymentType === 'Fee per Visit') {
          appointmentFees = rate;
        } else if (doctor.paymentType === 'Per Hour') {
          const mins = toNumber(appt.duration, 0);
          if (mins > 0) appointmentFees = rate * (mins / 60);
        }

        appointmentFees = toNumber(appointmentFees, 0);
        if (appointmentFees > 0) {
          totalAppointmentFees += appointmentFees;
          
          // Apply revenue percentage
          const percentage = toNumber(doctor.revenuePercentage, 100);
          const doctorAmount = (appointmentFees * percentage) / 100;
          totalDoctorAmount += doctorAmount;
          
          doctorNotes += `${appt._id} (Fees: ₹${appointmentFees.toFixed(2)}, Doctor: ${percentage}% = ₹${doctorAmount.toFixed(2)}), `;
        }
      }

      const hospitalRevenue = totalAppointmentFees - totalDoctorAmount;
      totalHospitalRevenue += hospitalRevenue;

      if (totalDoctorAmount <= 0) {
        results.push({
          doctor: doctor._id,
          doctorName: `${doctor.firstName} ${doctor.lastName}`,
          status: 'no_earnings',
          amount: 0,
          appointments: appointments.length,
          hospitalRevenue: hospitalRevenue
        });
        continue;
      }

      const existingSalary = await Salary.findOne({
        doctor_id: doctor._id,
        period_type: periodType,
        period_start: periodStart,
        period_end: periodEnd
      });

      if (existingSalary && existingSalary.status === 'paid') {
        results.push({
          doctor: doctor._id,
          doctorName: `${doctor.firstName} ${doctor.lastName}`,
          status: 'already_paid',
          amount: existingSalary.net_amount,
          appointments: appointments.length,
          hospitalRevenue: hospitalRevenue,
          salaryId: existingSalary._id
        });
        continue;
      }

      let salaryDoc;
      if (existingSalary) {
        salaryDoc = await Salary.findByIdAndUpdate(
          existingSalary._id,
          {
            amount: totalDoctorAmount,
            appointment_count: appointments.length,
            net_amount: totalDoctorAmount,
            status: 'paid',
            payment_method: payment_method || 'bank_transfer',
            paid_date: new Date(),
            notes: `${notes || ''} | ${doctorNotes}`.trim()
          },
          { new: true }
        );
      } else {
        salaryDoc = new Salary({
          doctor_id: doctor._id,
          period_type: periodType,
          period_start: periodStart,
          period_end: periodEnd,
          amount: totalDoctorAmount,
          appointment_count: appointments.length,
          net_amount: totalDoctorAmount,
          status: 'paid',
          payment_method: payment_method || 'bank_transfer',
          paid_date: new Date(),
          notes: `${notes || ''} | ${doctorNotes}`.trim()
        });
        await salaryDoc.save();
      }

      totalAmount += totalDoctorAmount;
      totalAppointments += appointments.length;

      results.push({
        doctor: doctor._id,
        doctorName: `${doctor.firstName} ${doctor.lastName}`,
        status: 'paid',
        amount: totalDoctorAmount,
        appointments: appointments.length,
        hospitalRevenue: hospitalRevenue,
        salaryId: salaryDoc._id,
        revenuePercentage: doctor.revenuePercentage
      });
    }

    res.json({
      success: true,
      periodType,
      period: { start: startDate, end: endDate },
      totalDoctorAmount: totalAmount,
      totalHospitalRevenue: totalHospitalRevenue,
      totalAppointments,
      totalDoctors: partTimeDoctors.length,
      processedDoctors: results.length,
      results
    });
  } catch (error) {
    console.error('Error in bulk salary calculation:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.calculateAppointmentSalary = async (req, res) => {
  try {
    const { appointmentId } = req.params;

    if (!isValidObjectId(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointmentId' });
    }

    const salary = await exports.calculatePartTimeSalary(appointmentId);

    if (salary) return res.json(salary);

    return res.json({
      message: 'No salary calculated (doctor may be on fixed salary or appointment not completed)'
    });
  } catch (error) {
    console.error('Error in calculateAppointmentSalary:', error);
    res.status(500).json({ error: 'Failed to calculate salary' });
  }
};

exports.calculateFullTimeSalaries = async () => {
  try {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const fullTimeDoctors = await Doctor.find({
      isFullTime: true,
      paymentType: { $in: ['Salary', 'Contractual Salary'] }
    });

    const results = [];

    for (const doctor of fullTimeDoctors) {
      const existing = await Salary.findOne({
        doctor_id: doctor._id,
        period_type: 'monthly',
        period_start: firstDay,
        period_end: lastDay
      });

      if (existing) {
        results.push({ doctor: doctor._id, status: 'already_exists', salary: existing._id });
        continue;
      }

      const baseSalary = toNumber(doctor.amount, 0);

      const salary = new Salary({
        doctor_id: doctor._id,
        period_type: 'monthly',
        period_start: firstDay,
        period_end: lastDay,
        amount: baseSalary,
        base_salary: baseSalary,
        net_amount: baseSalary,
        notes:
          doctor.paymentType === 'Contractual Salary'
            ? 'Contractual monthly salary'
            : 'Monthly salary',
        status: 'pending'
      });

      await salary.save();
      results.push({ doctor: doctor._id, status: 'created', salary: salary._id });
    }

    return results;
  } catch (error) {
    console.error('Error calculating full-time salaries:', error);
    throw error;
  }
};

// -------------------- GET: doctor salary history --------------------
exports.getDoctorSalaryHistory = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { period, startDate, endDate, page = 1, limit = 10 } = req.query;

    if (!isValidObjectId(doctorId)) {
      return res.status(400).json({ error: 'Invalid doctorId' });
    }

    // AUTO-GENERATE current month salary for fixed salary doctors (non-blocking)
    try {
      const doctor = await Doctor.findById(doctorId);
      if (doctor && ['Salary', 'Contractual Salary'].includes(doctor.paymentType)) {
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        const exists = await Salary.findOne({
          doctor_id: doctorId,
          period_type: 'monthly',
          period_start: firstDay,
          period_end: lastDay
        });

        if (!exists) {
          const amt = toNumber(doctor.amount, 0);
          await new Salary({
            doctor_id: doctorId,
            period_type: 'monthly',
            period_start: firstDay,
            period_end: lastDay,
            amount: amt,
            base_salary: amt,
            net_amount: amt,
            status: 'pending',
            notes: `Auto-generated monthly salary for ${now.toLocaleString('default', {
              month: 'long'
            })}`
          }).save();
        }
      }
    } catch (err) {
      console.error('Auto-generate salary error:', err);
    }

    const filter = { doctor_id: doctorId };
    if (period) filter.period_type = period;

    const start = parseDateOrNull(startDate);
    const end = parseDateOrNull(endDate);
    if (start && end) addOverlapPeriodFilter(filter, start, end);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [salaries, total] = await Promise.all([
      Salary.find(filter)
        .sort({ period_start: -1 })
        .limit(limitNum)
        .skip(skip)
        .populate('created_by', 'name')
        .populate('doctor_id', 'firstName lastName paymentType amount'),
      Salary.countDocuments(filter)
    ]);

    res.json({
      salaries,
      totalPages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// -------------------- GET: all salaries with filters --------------------
exports.getAllSalaries = async (req, res) => {
  try {
    const { status, periodType, doctorId, startDate, endDate, page = 1, limit = 10 } = req.query;

    const filter = {};

    if (status && status !== 'all') filter.status = status;
    if (periodType && periodType !== 'all') filter.period_type = periodType;
    if (doctorId && doctorId !== 'all') {
      if (!isValidObjectId(doctorId)) return res.status(400).json({ error: 'Invalid doctorId' });
      filter.doctor_id = doctorId;
    }

    const start = parseDateOrNull(startDate);
    const end = parseDateOrNull(endDate);
    if (start && end) addOverlapPeriodFilter(filter, start, end);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [salaries, total] = await Promise.all([
      Salary.find(filter)
        .populate('doctor_id', 'firstName lastName paymentType amount isFullTime')
        .sort({ period_start: -1 })
        .limit(limitNum)
        .skip(skip),
      Salary.countDocuments(filter)
    ]);

    res.json({
      salaries,
      totalPages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// -------------------- PUT: update salary status --------------------
exports.updateSalaryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, payment_method, paid_date, notes } = req.body;

    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid salary id' });

    if (status && !ALLOWED_SALARY_STATUSES.has(String(status).toLowerCase())) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const update = {};
    if (status) update.status = String(status).toLowerCase();
    if (payment_method) update.payment_method = payment_method;
    if (notes !== undefined) update.notes = notes;

    // Only set paid_date when marking paid, or if explicitly provided
    if (update.status === 'paid') {
      update.paid_date = paid_date ? new Date(paid_date) : new Date();
    } else if (paid_date) {
      update.paid_date = new Date(paid_date);
    }

    const salary = await Salary.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true
    }).populate('doctor_id', 'firstName lastName paymentType amount');

    if (!salary) return res.status(404).json({ error: 'Salary record not found' });

    res.json(salary);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// -------------------- GET: salary statistics --------------------
exports.getSalaryStatistics = async (req, res) => {
  try {
    const { period, startDate, endDate } = req.query;

    const filter = {};
    if (period && period !== 'all') filter.period_type = period;

    const start = parseDateOrNull(startDate);
    const end = parseDateOrNull(endDate);
    if (start && end) addOverlapPeriodFilter(filter, start, end);

    const [byStatus, overallArr] = await Promise.all([
      Salary.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalAmount: { $sum: '$net_amount' }
          }
        }
      ]),
      Salary.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalRecords: { $sum: 1 },
            totalAmount: { $sum: '$net_amount' },
            averageSalary: { $avg: '$net_amount' }
          }
        }
      ])
    ]);

    res.json({
      byStatus,
      overall: overallArr[0] || { totalRecords: 0, totalAmount: 0, averageSalary: 0 }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// -------------------- POST: bulk pay existing salary records --------------------
exports.bulkPaySalaries = async (req, res) => {
  try {
    const { salaryIds, payment_method, paid_date, notes } = req.body;

    if (!salaryIds || !Array.isArray(salaryIds) || salaryIds.length === 0) {
      return res.status(400).json({ error: 'Please provide an array of salary IDs to pay.' });
    }

    const results = [];
    let totalAmount = 0;
    let successCount = 0;
    let failCount = 0;

    for (const salaryId of salaryIds) {
      try {
        if (!isValidObjectId(salaryId)) {
          results.push({ salaryId, status: 'failed', error: 'Invalid salary id' });
          failCount++;
          continue;
        }

        const salary = await Salary.findById(salaryId).populate('doctor_id', 'firstName lastName');

        if (!salary) {
          results.push({ salaryId, status: 'not_found', error: 'Salary record not found' });
          failCount++;
          continue;
        }

        if (salary.status === 'paid') {
          results.push({
            salaryId,
            status: 'already_paid',
            doctor: salary.doctor_id
              ? `${salary.doctor_id.firstName} ${salary.doctor_id.lastName}`
              : 'Unknown',
            amount: salary.net_amount
          });
          continue;
        }

        const updated = await Salary.findByIdAndUpdate(
          salaryId,
          {
            status: 'paid',
            payment_method: payment_method || salary.payment_method || 'bank_transfer',
            paid_date: paid_date ? new Date(paid_date) : new Date(),
            notes: `${salary.notes || ''} | ${notes || 'Bulk payment processed'}`.trim()
          },
          { new: true }
        ).populate('doctor_id', 'firstName lastName');

        totalAmount += toNumber(updated.net_amount, 0);
        successCount++;

        results.push({
          salaryId,
          status: 'paid',
          doctor: updated.doctor_id
            ? `${updated.doctor_id.firstName} ${updated.doctor_id.lastName}`
            : 'Unknown',
          amount: updated.net_amount,
          period: `${updated.period_start.toISOString().split('T')[0]} to ${updated.period_end
            .toISOString()
            .split('T')[0]}`
        });
      } catch (err) {
        results.push({ salaryId, status: 'failed', error: err.message });
        failCount++;
      }
    }

    res.json({
      success: true,
      summary: {
        totalProcessed: salaryIds.length,
        successCount,
        failCount,
        totalAmount
      },
      results
    });
  } catch (error) {
    console.error('Error in bulk salary payment:', error);
    res.status(500).json({ error: error.message });
  }
};

// -------------------- GET: pending salaries --------------------
exports.getPendingSalaries = async (req, res) => {
  try {
    const { periodType, doctorId, startDate, endDate, page = 1, limit = 20 } = req.query;

    const filter = { status: 'pending' };

    if (periodType && periodType !== 'all') filter.period_type = periodType;

    if (doctorId && doctorId !== 'all') {
      if (!isValidObjectId(doctorId)) return res.status(400).json({ error: 'Invalid doctorId' });
      filter.doctor_id = doctorId;
    }

    const start = parseDateOrNull(startDate);
    const end = parseDateOrNull(endDate);
    if (start && end) addOverlapPeriodFilter(filter, start, end);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [salaries, total, totalsAgg] = await Promise.all([
      Salary.find(filter)
        .populate('doctor_id', 'firstName lastName paymentType amount isFullTime')
        .sort({ period_start: 1, doctor_id: 1 })
        .limit(limitNum)
        .skip(skip),
      Salary.countDocuments(filter),
      Salary.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: '$net_amount' },
            totalRecords: { $sum: 1 }
          }
        }
      ])
    ]);

    res.json({
      salaries,
      totals: totalsAgg[0] || { totalAmount: 0, totalRecords: 0 },
      totalPages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// -------------------- GET: salary report (paid) --------------------
exports.generateSalaryPaymentReport = async (req, res) => {
  try {
    const { periodType, startDate, endDate, format = 'json' } = req.query;

    if (!periodType || !['daily', 'weekly', 'monthly'].includes(periodType)) {
      return res.status(400).json({ error: 'periodType is required: daily/weekly/monthly' });
    }

    const start = parseDateOrNull(startDate);
    const end = parseDateOrNull(endDate);
    if (!start || !end) return res.status(400).json({ error: 'Invalid startDate/endDate' });

    // Find paid salaries whose period overlaps the requested range
    const match = {
      status: 'paid',
      period_type: periodType,
      period_start: { $lte: end },
      period_end: { $gte: start }
    };

    const salaries = await Salary.find(match)
      .populate('doctor_id', 'firstName lastName paymentType amount isFullTime')
      .sort({ paid_date: -1 });

    // ✅ FIX: aggregation must $lookup doctors BEFORE grouping by paymentType
    const summary = await Salary.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'doctors',
          localField: 'doctor_id',
          foreignField: '_id',
          as: 'doctor'
        }
      },
      { $unwind: '$doctor' },
      {
        $group: {
          _id: {
            doctor_id: '$doctor._id',
            paymentType: '$doctor.paymentType'
          },
          doctorName: { $first: { $concat: ['$doctor.firstName', ' ', '$doctor.lastName'] } },
          paymentType: { $first: '$doctor.paymentType' },
          totalAmount: { $sum: '$net_amount' },
          totalAppointments: { $sum: '$appointment_count' },
          paymentCount: { $sum: 1 }
        }
      },
      { $sort: { totalAmount: -1 } }
    ]);

    if (format === 'csv') {
      let csv = 'Doctor Name,Payment Type,Amount,Appointments,Payment Date\n';
      salaries.forEach((s) => {
        const d = s.doctor_id;
        csv += `"${d ? `${d.firstName} ${d.lastName}` : 'Unknown'}",${d?.paymentType || ''},${
          s.net_amount
        },${s.appointment_count || 0},${s.paid_date ? s.paid_date.toISOString().split('T')[0] : ''}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=salary-report-${startDate}-to-${endDate}.csv`
      );
      return res.send(csv);
    }

    res.json({
      period: { start: startDate, end: endDate, type: periodType },
      summary: {
        totalAmount: summary.reduce((sum, item) => sum + toNumber(item.totalAmount, 0), 0),
        totalAppointments: summary.reduce((sum, item) => sum + toNumber(item.totalAppointments, 0), 0),
        totalPayments: summary.reduce((sum, item) => sum + toNumber(item.paymentCount, 0), 0),
        byPaymentType: summary
      },
      detailed: salaries
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
