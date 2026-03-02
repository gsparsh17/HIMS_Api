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

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

const addOverlapPeriodFilter = (filter, start, end) => {
  if (!start || !end) return filter;
  filter.period_start = { $lte: end };
  filter.period_end = { $gte: start };
  return filter;
};

// ✅ include processing + hold
const ALLOWED_SALARY_STATUSES = new Set(['pending', 'processing', 'paid', 'cancelled', 'hold']);

const normalizeStatus = (s) => (s ? String(s).toLowerCase().trim() : s);

const monthRange = (year, month1to12) => {
  const y = parseInt(year, 10);
  const m = parseInt(month1to12, 10) - 1;
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 0 || m > 11) return null;
  const start = new Date(y, m, 1, 0, 0, 0, 0);
  const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
  return { start, end };
};

const isSalaryDoctor = (doctor) => {
  if (!doctor) return false;
  return Boolean(
    doctor.isFullTime &&
      ['Salary', 'Contractual Salary'].includes(doctor.paymentType)
  );
};

const isCommissionDoctor = (doctor) => {
  if (!doctor) return false;
  return Boolean(
    !doctor.isFullTime &&
      ['Fee per Visit', 'Per Hour'].includes(doctor.paymentType)
  );
};

// Appointment fees calculation based on doctor paymentType
const calculateAppointmentFees = (doctor, appointment) => {
  const rate = toNumber(doctor?.amount, 0);
  if (!doctor || !appointment) return { fees: 0, notes: 'Invalid doctor/appointment' };

  switch (doctor.paymentType) {
    case 'Fee per Visit':
      return { fees: rate, notes: `Type: Per Visit, Rate: ₹${rate}` };

    case 'Per Hour': {
      const durationMin = toNumber(appointment.duration, 0);
      if (durationMin <= 0) return { fees: 0, notes: 'Missing duration for hourly payment' };
      const hours = durationMin / 60;
      return { fees: rate * hours, notes: `Type: Per Hour, Duration: ${durationMin}min, Rate: ₹${rate}/hr` };
    }

    default:
      return { fees: 0, notes: `Unsupported paymentType: ${doctor.paymentType}` };
  }
};

// Revenue distribution (commission doctors only)
const calculateRevenueDistribution = (doctor, appointmentFees) => {
  const totalFees = toNumber(appointmentFees, 0);
  const percentage = toNumber(doctor?.revenuePercentage, 100);
  const doctorShare = (totalFees * percentage) / 100;
  const hospitalShare = totalFees - doctorShare;
  return { totalFees, percentage, doctorShare, hospitalShare };
};

// ===================================================================
// ✅ Part-time commission calculation (per completed appointment)
// ===================================================================
exports.calculatePartTimeSalary = async (appointmentId) => {
  try {
    if (!isValidObjectId(appointmentId)) return null;

    const appointment = await Appointment.findById(appointmentId)
      .populate('doctor_id')
      .populate('patient_id');

    if (!appointment || appointment.status !== 'Completed') return null;

    const doctor = appointment.doctor_id;
    if (!doctor) return null;

    // ✅ Only commission doctors here
    if (!isCommissionDoctor(doctor)) return null;

    const { fees, notes: feesNotes } = calculateAppointmentFees(doctor, appointment);
    const appointmentFees = toNumber(fees, 0);
    if (appointmentFees <= 0) return null;

    const { totalFees, percentage, doctorShare, hospitalShare } =
      calculateRevenueDistribution(doctor, appointmentFees);

    const baseDate =
      appointment.actual_end_time ||
      appointment.updatedAt ||
      appointment.appointment_date ||
      new Date();

    const periodStart = startOfDay(new Date(baseDate));
    const periodEnd = endOfDay(new Date(baseDate));

    let notes = `Appointment: ${appointment._id}, Patient: ${
      appointment.patient_id?.first_name || 'Unknown'
    } | ${feesNotes} | Total Fees: ₹${totalFees.toFixed(2)}, Doctor Share: ${percentage}% (₹${doctorShare.toFixed(
      2
    )}), Hospital: ₹${hospitalShare.toFixed(2)}`;

    // Find existing daily commission record
    let salary = await Salary.findOne({
      doctor_id: doctor._id,
      period_type: 'daily',
      period_start: periodStart,
      period_end: periodEnd
    });

    const alreadyAdded = (salary?.appointments || []).some(
      (a) => String(a) === String(appointmentId)
    );
    if (salary && alreadyAdded) return salary;

    if (salary) {
      salary.amount = toNumber(salary.amount, 0) + doctorShare;
      salary.net_amount =
        toNumber(salary.amount, 0) +
        toNumber(salary.bonus, 0) -
        toNumber(salary.deductions, 0);

      salary.appointment_count = toNumber(salary.appointment_count, 0) + 1;
      salary.appointments = salary.appointments || [];
      salary.appointments.push(appointmentId);

      // These fields require schema support; harmless if schema ignores them
      salary.gross_amount = toNumber(salary.gross_amount, 0) + totalFees;
      salary.doctor_share = toNumber(salary.doctor_share, 0) + doctorShare;
      salary.hospital_share = toNumber(salary.hospital_share, 0) + hospitalShare;
      salary.revenue_percentage = percentage;

      salary.notes = salary.notes ? `${salary.notes} | ${notes}` : notes;
      await salary.save();
      return salary;
    }

    salary = new Salary({
      doctor_id: doctor._id,

      // ✅ for future-proofing (needs schema field, else ignored)
      earning_type: 'commission',

      period_type: 'daily',
      period_start: periodStart,
      period_end: periodEnd,

      // amount/net_amount = doctor commission
      amount: doctorShare,
      net_amount: doctorShare,

      appointment_count: 1,
      appointments: [appointmentId],

      // commission breakdown (needs schema fields, else ignored)
      gross_amount: totalFees,
      doctor_share: doctorShare,
      hospital_share: hospitalShare,
      revenue_percentage: percentage,

      notes,
      status: 'pending'
    });

    await salary.save();
    return salary;
  } catch (error) {
    console.error('Error calculating part-time commission:', error);
    return null;
  }
};

// API wrapper for above
exports.calculateAppointmentSalary = async (req, res) => {
  try {
    const { appointmentId } = req.params;

    if (!isValidObjectId(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointmentId' });
    }

    const salary = await exports.calculatePartTimeSalary(appointmentId);

    if (salary) return res.json(salary);

    return res.json({
      message: 'No commission calculated (doctor may be full-time / fixed salary OR appointment not completed)'
    });
  } catch (error) {
    console.error('Error in calculateAppointmentSalary:', error);
    res.status(500).json({ error: 'Failed to calculate commission' });
  }
};

// ===================================================================
// ✅ Full-time monthly salary generator
// ===================================================================
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

        // ✅ for future-proofing (needs schema field, else ignored)
        earning_type: 'salary',

        period_type: 'monthly',
        period_start: firstDay,
        period_end: lastDay,
        amount: baseSalary,
        base_salary: baseSalary,
        net_amount: baseSalary,
        notes: doctor.paymentType === 'Contractual Salary' ? 'Contractual monthly salary' : 'Monthly salary',
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

// ===================================================================
// ✅ GET: doctor salary/commission history
// Full-time => salary only (monthly)
// Part-time => commission only
// ===================================================================
exports.getDoctorSalaryHistory = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const {
      period,
      startDate,
      endDate,
      status,
      year,
      month,
      page = 1,
      limit = 10
    } = req.query;

    if (!isValidObjectId(doctorId)) {
      return res.status(400).json({ error: 'Invalid doctorId' });
    }

    const doctor = await Doctor.findById(doctorId).select(
      'isFullTime paymentType amount revenuePercentage firstName lastName'
    );
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const earningType = isSalaryDoctor(doctor) ? 'salary' : 'commission';

    // ✅ auto-generate current month salary for salary doctors
    if (earningType === 'salary') {
      try {
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
            earning_type: 'salary',
            period_type: 'monthly',
            period_start: firstDay,
            period_end: lastDay,
            amount: amt,
            base_salary: amt,
            net_amount: amt,
            status: 'pending',
            notes: 'Auto-generated monthly salary'
          }).save();
        }
      } catch (e) {
        console.error('Auto-generate salary error:', e);
      }
    }

    const filter = { doctor_id: doctorId };

    // Backward compatibility if earning_type is not in old docs
    if (earningType === 'salary') {
      filter.period_type = 'monthly';
      filter.$or = [{ earning_type: 'salary' }, { earning_type: { $exists: false } }];
    } else {
      // commission doctors
      if (period && period !== 'all') filter.period_type = period;
      filter.$or = [{ earning_type: 'commission' }, { earning_type: { $exists: false } }];
    }

    if (status && status !== 'all') {
      filter.status = normalizeStatus(status);
    }

    // Month/year filter for monthly view
    if ((filter.period_type === 'monthly' || earningType === 'salary') && year && month) {
      const mr = monthRange(year, month);
      if (mr) {
        filter.period_start = { $gte: mr.start, $lte: mr.end };
      }
    } else {
      const start = parseDateOrNull(startDate);
      const end = parseDateOrNull(endDate);
      if (start && end) addOverlapPeriodFilter(filter, start, end);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 10));
    const skip = (pageNum - 1) * limitNum;

    const [salaries, total] = await Promise.all([
      Salary.find(filter)
        .sort({ period_start: -1 })
        .limit(limitNum)
        .skip(skip)
        .populate('created_by', 'name')
        .populate('doctor_id', 'firstName lastName paymentType amount isFullTime revenuePercentage'),
      Salary.countDocuments(filter)
    ]);

    res.json({
      earningType, // ✅ frontend uses this to decide Salary vs Commission UI
      salaries,
      totalPages: Math.ceil(total / limitNum),
      currentPage: pageNum,
      total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ===================================================================
// ✅ GET: all salaries (admin) with filters
// ===================================================================
exports.getAllSalaries = async (req, res) => {
  try {
    const {
      status,
      periodType,
      doctorId,
      startDate,
      endDate,
      earningType, // optional: salary|commission
      page = 1,
      limit = 10
    } = req.query;

    const filter = {};

    if (status && status !== 'all') filter.status = normalizeStatus(status);
    if (periodType && periodType !== 'all') filter.period_type = periodType;

    if (earningType && ['salary', 'commission'].includes(String(earningType))) {
      // backward compatible
      filter.$or = [{ earning_type: earningType }, { earning_type: { $exists: false } }];
    }

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
        .populate('doctor_id', 'firstName lastName paymentType amount isFullTime revenuePercentage')
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

// ===================================================================
// ✅ PUT: update salary/commission status
// ===================================================================
exports.updateSalaryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, payment_method, paid_date, notes } = req.body;

    if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid salary id' });

    const nextStatus = status ? normalizeStatus(status) : undefined;
    if (nextStatus && !ALLOWED_SALARY_STATUSES.has(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const update = {};
    if (nextStatus) update.status = nextStatus;
    if (payment_method) update.payment_method = payment_method;
    if (notes !== undefined) update.notes = notes;

    if (update.status === 'paid') {
      update.paid_date = paid_date ? new Date(paid_date) : new Date();
    } else if (paid_date) {
      update.paid_date = new Date(paid_date);
    }

    const salary = await Salary.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true
    }).populate('doctor_id', 'firstName lastName paymentType amount isFullTime revenuePercentage');

    if (!salary) return res.status(404).json({ error: 'Salary record not found' });

    res.json(salary);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ===================================================================
// ✅ GET: salary/commission statistics (supports doctorId)
// ===================================================================
exports.getSalaryStatistics = async (req, res) => {
  try {
    const { period, startDate, endDate, doctorId, earningType } = req.query;

    const filter = {};

    if (doctorId && isValidObjectId(doctorId)) {
      filter.doctor_id = new mongoose.Types.ObjectId(doctorId);
    }

    if (period && period !== 'all') filter.period_type = period;

    if (earningType && ['salary', 'commission'].includes(String(earningType))) {
      filter.$or = [{ earning_type: earningType }, { earning_type: { $exists: false } }];
    }

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

// ===================================================================
// ✅ POST: bulk calculate & pay PART-TIME commissions
// ===================================================================
exports.bulkCalculateAndPayPartTimeSalaries = async (req, res) => {
  try {
    const { periodType, startDate, endDate, payment_method, notes } = req.body;

    if (!['daily', 'weekly', 'monthly'].includes(periodType)) {
      return res.status(400).json({ error: 'Invalid period type. Use daily, weekly, or monthly.' });
    }

    const startRaw = parseDateOrNull(startDate);
    const endRaw = parseDateOrNull(endDate);
    if (!startRaw || !endRaw) return res.status(400).json({ error: 'Invalid date format.' });

    const periodStart = startOfDay(startRaw);
    const periodEnd = endOfDay(endRaw);

    const partTimeDoctors = await Doctor.find({
      isFullTime: false,
      paymentType: { $in: ['Fee per Visit', 'Per Hour'] }
    });

    const results = [];
    let totalDoctorAmount = 0;
    let totalAppointments = 0;
    let totalHospitalRevenue = 0;

    for (const doctor of partTimeDoctors) {
      const appointments = await Appointment.find({
        doctor_id: doctor._id,
        status: 'Completed',
        actual_end_time: { $gte: periodStart, $lte: periodEnd }
      });

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

      const percentage = toNumber(doctor.revenuePercentage, 100);

      let totalGross = 0;
      let totalDocShare = 0;

      let doctorNotes = `Bulk ${periodType} commission payment: ${startDate} to ${endDate}. `;

      for (const appt of appointments) {
        const { fees } = calculateAppointmentFees(doctor, appt);
        const gross = toNumber(fees, 0);
        if (gross <= 0) continue;

        const docShare = (gross * percentage) / 100;

        totalGross += gross;
        totalDocShare += docShare;

        doctorNotes += `${appt._id}(₹${gross.toFixed(2)} => ₹${docShare.toFixed(2)}), `;
      }

      const hospitalRevenue = totalGross - totalDocShare;

      if (totalDocShare <= 0) {
        results.push({
          doctor: doctor._id,
          doctorName: `${doctor.firstName} ${doctor.lastName}`,
          status: 'no_earnings',
          amount: 0,
          appointments: appointments.length,
          hospitalRevenue
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
          hospitalRevenue,
          salaryId: existingSalary._id
        });
        continue;
      }

      const payload = {
        earning_type: 'commission',
        amount: totalDocShare,
        appointment_count: appointments.length,
        net_amount: totalDocShare,
        status: 'paid',
        payment_method: payment_method || 'bank_transfer',
        paid_date: new Date(),
        notes: `${notes || ''} | ${doctorNotes}`.trim(),

        // commission breakdown (needs schema support, else ignored)
        gross_amount: totalGross,
        doctor_share: totalDocShare,
        hospital_share: hospitalRevenue,
        revenue_percentage: percentage
      };

      let salaryDoc;
      if (existingSalary) {
        salaryDoc = await Salary.findByIdAndUpdate(existingSalary._id, payload, { new: true });
      } else {
        salaryDoc = new Salary({
          doctor_id: doctor._id,
          period_type: periodType,
          period_start: periodStart,
          period_end: periodEnd,
          ...payload
        });
        await salaryDoc.save();
      }

      totalDoctorAmount += totalDocShare;
      totalAppointments += appointments.length;
      totalHospitalRevenue += hospitalRevenue;

      results.push({
        doctor: doctor._id,
        doctorName: `${doctor.firstName} ${doctor.lastName}`,
        status: 'paid',
        amount: totalDocShare,
        appointments: appointments.length,
        hospitalRevenue,
        salaryId: salaryDoc._id,
        revenuePercentage: percentage
      });
    }

    res.json({
      success: true,
      earningType: 'commission',
      periodType,
      period: { start: startDate, end: endDate },
      totalDoctorAmount,
      totalHospitalRevenue,
      totalAppointments,
      totalDoctors: partTimeDoctors.length,
      processedDoctors: results.length,
      results
    });
  } catch (error) {
    console.error('Error in bulk commission calculation:', error);
    res.status(500).json({ error: error.message });
  }
};

// ===================================================================
// ✅ POST: bulk pay existing salary/commission records
// ===================================================================
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
            doctor: salary.doctor_id ? `${salary.doctor_id.firstName} ${salary.doctor_id.lastName}` : 'Unknown',
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
          doctor: updated.doctor_id ? `${updated.doctor_id.firstName} ${updated.doctor_id.lastName}` : 'Unknown',
          amount: updated.net_amount,
          period: `${updated.period_start.toISOString().split('T')[0]} to ${updated.period_end.toISOString().split('T')[0]}`
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

// ===================================================================
// ✅ GET: pending salaries/commissions
// ===================================================================
exports.getPendingSalaries = async (req, res) => {
  try {
    const { periodType, doctorId, startDate, endDate, earningType, page = 1, limit = 20 } = req.query;

    const filter = { status: 'pending' };

    if (periodType && periodType !== 'all') filter.period_type = periodType;

    if (earningType && ['salary', 'commission'].includes(String(earningType))) {
      filter.$or = [{ earning_type: earningType }, { earning_type: { $exists: false } }];
    }

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
        .populate('doctor_id', 'firstName lastName paymentType amount isFullTime revenuePercentage')
        .sort({ period_start: 1, doctor_id: 1 })
        .limit(limitNum)
        .skip(skip),
      Salary.countDocuments(filter),
      Salary.aggregate([
        { $match: filter },
        { $group: { _id: null, totalAmount: { $sum: '$net_amount' }, totalRecords: { $sum: 1 } } }
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

// ===================================================================
// ✅ GET: salary/commission report (paid)
// ===================================================================
exports.generateSalaryPaymentReport = async (req, res) => {
  try {
    const { periodType, startDate, endDate, earningType, format = 'json' } = req.query;

    if (!periodType || !['daily', 'weekly', 'monthly'].includes(periodType)) {
      return res.status(400).json({ error: 'periodType is required: daily/weekly/monthly' });
    }

    const start = parseDateOrNull(startDate);
    const end = parseDateOrNull(endDate);
    if (!start || !end) return res.status(400).json({ error: 'Invalid startDate/endDate' });

    const match = {
      status: 'paid',
      period_type: periodType,
      period_start: { $lte: end },
      period_end: { $gte: start }
    };

    if (earningType && ['salary', 'commission'].includes(String(earningType))) {
      match.$or = [{ earning_type: earningType }, { earning_type: { $exists: false } }];
    }

    const salaries = await Salary.find(match)
      .populate('doctor_id', 'firstName lastName paymentType amount isFullTime revenuePercentage')
      .sort({ paid_date: -1 });

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
        csv += `"${d ? `${d.firstName} ${d.lastName}` : 'Unknown'}",${d?.paymentType || ''},${s.net_amount},${
          s.appointment_count || 0
        },${s.paid_date ? s.paid_date.toISOString().split('T')[0] : ''}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=salary-report-${startDate}-to-${endDate}.csv`);
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