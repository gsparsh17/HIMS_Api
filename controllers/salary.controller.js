const Salary = require('../models/Salary');
const Doctor = require('../models/Doctor');
const Appointment = require('../models/Appointment');
const mongoose = require('mongoose');

exports.calculatePartTimeSalary = async (appointmentId) => {
  try {
    const appointment = await Appointment.findById(appointmentId)
      .populate('doctor_id')
      .populate('patient_id');

    if (!appointment || appointment.status !== 'Completed') {
      console.log('Appointment not found or not completed');
      return null;
    }

    const doctor = appointment.doctor_id;
    
    // Check payment type instead of just isFullTime flag for more robustness
    if (['Salary', 'Contractual Salary'].includes(doctor.paymentType)) {
      console.log('Doctor is on fixed salary, no per-visit calculation needed');
      return null;
    }

    let amount = 0;
    let notes = `Appointment: ${appointment._id}, Patient: ${appointment.patient_id?.first_name || 'Unknown'}`;

    switch (doctor.paymentType) {
      case 'Fee per Visit':
        amount = doctor.amount || 0;
        notes += `, Type: Per Visit`;
        break;
      
      case 'Per Hour':
        if (appointment.duration) {
          const hours = appointment.duration / 60; // Convert minutes to hours
          amount = (doctor.amount || 0) * hours;
          notes += `, Duration: ${appointment.duration}min, Rate: ₹${doctor.amount}/hr`;
        }
        break;
      
      default:
        console.log('Unknown payment type:', doctor.paymentType);
        return null;
    }

    if (amount <= 0) {
      console.log('No amount calculated for salary');
      return null;
    }

    const today = new Date();
    const periodStart = new Date(today.setHours(0, 0, 0, 0));
    const periodEnd = new Date(today.setHours(23, 59, 59, 999));

    try {
      // Check if salary entry already exists for today
      let salary = await Salary.findOne({
        doctor_id: doctor._id,
        period_type: 'daily',
        period_start: periodStart,
        period_end: periodEnd
      });

      if (salary) {
        // Update existing entry
        salary.amount += amount;
        salary.appointment_count += 1;
        salary.net_amount = salary.amount + (salary.bonus || 0) - (salary.deductions || 0);
        salary.notes = salary.notes ? `${salary.notes} | ${notes}` : notes;
        await salary.save();
        console.log('Updated existing salary entry:', salary._id);
      } else {
        // Create new entry
        salary = new Salary({
          doctor_id: doctor._id,
          period_type: 'daily',
          period_start: periodStart,
          period_end: periodEnd,
          amount: amount,
          appointment_count: 1,
          net_amount: amount,
          notes: notes,
          status: 'pending'
        });
        await salary.save();
        console.log('Created new salary entry:', salary._id);
      }

      return salary;
    } catch (dbError) {
      console.error('Database error in salary calculation:', dbError);
      return null;
    }

  } catch (error) {
    console.error('Error calculating part-time salary:', error);
    // Don't throw the error to prevent server crash
    return null;
  }
};

// Add this new function to handle individual appointment salary calculation
exports.calculateAppointmentSalary = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const salary = await exports.calculatePartTimeSalary(appointmentId);
    
    if (salary) {
      res.json(salary);
    } else {
      res.json({ message: 'No salary calculated (doctor may be full-time or appointment not completed)' });
    }
  } catch (error) {
    console.error('Error in calculateAppointmentSalary:', error);
    res.status(500).json({ error: 'Failed to calculate salary' });
  }
};

// Calculate monthly salary for full-time doctors (run via cron job)
exports.calculateFullTimeSalaries = async () => {
  try {
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const fullTimeDoctors = await Doctor.find({ 
      isFullTime: true,
      paymentType: { $in: ['Salary', 'Contractual Salary'] }
    });

    const results = [];

    for (const doctor of fullTimeDoctors) {
      // Check if salary already calculated for this month
      const existingSalary = await Salary.findOne({
        doctor_id: doctor._id,
        period_type: 'monthly',
        period_start: firstDayOfMonth,
        period_end: lastDayOfMonth
      });

      if (existingSalary) {
        results.push({ doctor: doctor._id, status: 'already_exists' });
        continue;
      }

      let baseSalary = doctor.amount;
      let notes = 'Monthly salary';

      // For contractual doctors, you might want to add additional logic
      if (doctor.paymentType === 'Contractual Salary') {
        // Add contractual specific calculations if needed
        notes = 'Contractual monthly salary';
      }

      const salary = new Salary({
        doctor_id: doctor._id,
        period_type: 'monthly',
        period_start: firstDayOfMonth,
        period_end: lastDayOfMonth,
        amount: baseSalary,
        base_salary: baseSalary,
        net_amount: baseSalary,
        notes: notes,
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

// Get doctor's salary history
exports.getDoctorSalaryHistory = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { period, startDate, endDate, page = 1, limit = 10 } = req.query;

    // --- AUTO-GENERATE CHECK FOR FULL TIME DOCTORS ---
    // If querying for a full-time doctor, ensure current month's pending salary exists
    try {
      const doctor = await Doctor.findById(doctorId);
      if (doctor && ['Salary', 'Contractual Salary'].includes(doctor.paymentType)) {
        const now = new Date();
        const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        
        const exists = await Salary.findOne({
          doctor_id: doctorId,
          period_type: 'monthly',
          period_start: { $gte: firstDayOfMonth, $lte: lastDayOfMonth }
        });

        if (!exists) {
           await new Salary({
             doctor_id: doctorId,
             period_type: 'monthly',
             period_start: firstDayOfMonth,
             period_end: lastDayOfMonth,
             amount: doctor.amount,
             base_salary: doctor.amount,
             net_amount: doctor.amount,
             status: 'pending',
             notes: `Auto-generated monthly salary for ${now.toLocaleString('default', { month: 'long' })}`
           }).save();
        }
      }
    } catch (err) {
      console.error("Auto-generate salary error:", err);
      // Continue anyway, don't block the read
    }
    // --------------------------------------------------

    const filter = { doctor_id: doctorId };
    
    if (period) {
      filter.period_type = period;
    }
    
    if (startDate && endDate) {
      filter.period_start = { $gte: new Date(startDate) };
      filter.period_end = { $lte: new Date(endDate) };
    }

    const salaries = await Salary.find(filter)
      .sort({ period_start: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('created_by', 'name');

    const total = await Salary.countDocuments(filter);

    res.json({
      salaries,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get all salaries with filters
exports.getAllSalaries = async (req, res) => {
  try {
    const { status, periodType, doctorId, startDate, endDate, page = 1, limit = 10 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (periodType) filter.period_type = periodType;
    if (doctorId) filter.doctor_id = doctorId;
    
    if (startDate && endDate) {
      filter.period_start = { $gte: new Date(startDate) };
      filter.period_end = { $lte: new Date(endDate) };
    }

    const salaries = await Salary.find(filter)
      .populate('doctor_id', 'firstName lastName paymentType amount')
      .sort({ period_start: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Salary.countDocuments(filter);

    res.json({
      salaries,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Update salary status (mark as paid, etc.)
exports.updateSalaryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, payment_method, paid_date, notes } = req.body;

    const salary = await Salary.findByIdAndUpdate(
      id,
      {
        status,
        payment_method,
        paid_date: paid_date ? new Date(paid_date) : new Date(),
        notes
      },
      { new: true, runValidators: true }
    ).populate('doctor_id', 'firstName lastName');

    if (!salary) {
      return res.status(404).json({ error: 'Salary record not found' });
    }

    res.json(salary);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get salary statistics
exports.getSalaryStatistics = async (req, res) => {
  try {
    const { period, startDate, endDate } = req.query;

    const filter = {};
    if (period) filter.period_type = period;
    
    if (startDate && endDate) {
      filter.period_start = { $gte: new Date(startDate) };
      filter.period_end = { $lte: new Date(endDate) };
    }

    const stats = await Salary.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$net_amount' }
        }
      }
    ]);

    const totalStats = await Salary.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalRecords: { $sum: 1 },
          totalAmount: { $sum: '$net_amount' },
          averageSalary: { $avg: '$net_amount' }
        }
      }
    ]);

    res.json({
      byStatus: stats,
      overall: totalStats[0] || { totalRecords: 0, totalAmount: 0, averageSalary: 0 }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.bulkCalculateAndPayPartTimeSalaries = async (req, res) => {
  try {
    const { periodType, startDate, endDate, payment_method, notes } = req.body;
    
    // Validate period type
    if (!['daily', 'weekly', 'monthly'].includes(periodType)) {
      return res.status(400).json({ error: 'Invalid period type. Use daily, weekly, or monthly.' });
    }

    const periodStart = new Date(startDate);
    const periodEnd = new Date(endDate);
    
    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }

    // Get all part-time doctors with pending salaries for the period
    const partTimeDoctors = await Doctor.find({ 
      isFullTime: false,
      paymentType: { $in: ['Fee per Visit', 'Per Hour'] }
    });

    const results = [];
    let totalAmount = 0;
    let totalAppointments = 0;

    for (const doctor of partTimeDoctors) {
      // Find appointments for this doctor in the specified period
      const appointments = await Appointment.find({
        doctor_id: doctor._id,
        status: 'Completed',
        actual_end_time: {
          $gte: periodStart,
          $lte: periodEnd
        }
      }).populate('patient_id');

      if (appointments.length === 0) {
        results.push({
          doctor: doctor._id,
          doctorName: `${doctor.firstName} ${doctor.lastName}`,
          status: 'no_appointments',
          amount: 0,
          appointments: 0
        });
        continue;
      }

      let totalDoctorAmount = 0;
      let doctorNotes = `Bulk payment for ${periodType} period: ${startDate} to ${endDate}. Appointments: `;

      for (const appointment of appointments) {
        let amount = 0;

        switch (doctor.paymentType) {
          case 'Fee per Visit':
            amount = doctor.amount;
            break;
          
          case 'Per Hour':
            if (appointment.duration) {
              const hours = appointment.duration / 60;
              amount = doctor.amount * hours;
            }
            break;
        }

        if (amount > 0) {
          totalDoctorAmount += amount;
          doctorNotes += `${appointment._id} (₹${amount}), `;
        }
      }

      if (totalDoctorAmount > 0) {
        // Check if salary already exists for this period
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
            salaryId: existingSalary._id
          });
          continue;
        }

        let salary;
        if (existingSalary) {
          // Update existing pending salary
          salary = await Salary.findByIdAndUpdate(
            existingSalary._id,
            {
              amount: totalDoctorAmount,
              appointment_count: appointments.length,
              net_amount: totalDoctorAmount,
              status: 'paid',
              payment_method: payment_method || 'bank_transfer',
              paid_date: new Date(),
              notes: `${notes || ''} | ${doctorNotes}`
            },
            { new: true }
          );
        } else {
          // Create new salary entry
          salary = new Salary({
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
            notes: `${notes || ''} | ${doctorNotes}`
          });
          await salary.save();
        }

        totalAmount += totalDoctorAmount;
        totalAppointments += appointments.length;

        results.push({
          doctor: doctor._id,
          doctorName: `${doctor.firstName} ${doctor.lastName}`,
          status: 'paid',
          amount: totalDoctorAmount,
          appointments: appointments.length,
          salaryId: salary._id
        });
      } else {
        results.push({
          doctor: doctor._id,
          doctorName: `${doctor.firstName} ${doctor.lastName}`,
          status: 'no_earnings',
          amount: 0,
          appointments: appointments.length
        });
      }
    }

    res.json({
      success: true,
      periodType,
      period: { start: startDate, end: endDate },
      totalAmount,
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

// Bulk pay multiple pending salaries at once
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
            doctor: `${salary.doctor_id.firstName} ${salary.doctor_id.lastName}`,
            amount: salary.net_amount 
          });
          continue;
        }

        const updatedSalary = await Salary.findByIdAndUpdate(
          salaryId,
          {
            status: 'paid',
            payment_method: payment_method || salary.payment_method,
            paid_date: paid_date ? new Date(paid_date) : new Date(),
            notes: `${salary.notes || ''} | ${notes || 'Bulk payment processed'}`
          },
          { new: true }
        ).populate('doctor_id', 'firstName lastName');

        totalAmount += updatedSalary.net_amount;
        successCount++;

        results.push({
          salaryId,
          status: 'paid',
          doctor: `${updatedSalary.doctor_id.firstName} ${updatedSalary.doctor_id.lastName}`,
          amount: updatedSalary.net_amount,
          period: `${updatedSalary.period_start.toISOString().split('T')[0]} to ${updatedSalary.period_end.toISOString().split('T')[0]}`
        });

      } catch (error) {
        results.push({ salaryId, status: 'failed', error: error.message });
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

// Get pending salaries for bulk payment
exports.getPendingSalaries = async (req, res) => {
  try {
    const { periodType, doctorId, startDate, endDate, page = 1, limit = 20 } = req.query;

    const filter = { status: 'pending' };
    
    if (periodType) filter.period_type = periodType;
    if (doctorId) filter.doctor_id = doctorId;
    
    if (startDate && endDate) {
      filter.period_start = { $gte: new Date(startDate) };
      filter.period_end = { $lte: new Date(endDate) };
    }

    const salaries = await Salary.find(filter)
      .populate('doctor_id', 'firstName lastName paymentType amount isFullTime')
      .sort({ period_start: 1, doctor_id: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Salary.countDocuments(filter);

    // Calculate totals
    const totals = await Salary.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$net_amount' },
          totalRecords: { $sum: 1 }
        }
      }
    ]);

    res.json({
      salaries,
      totals: totals[0] || { totalAmount: 0, totalRecords: 0 },
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Generate salary payment report for a period
exports.generateSalaryPaymentReport = async (req, res) => {
  try {
    const { periodType, startDate, endDate, format = 'json' } = req.query;

    const periodStart = new Date(startDate);
    const periodEnd = new Date(endDate);

    const salaries = await Salary.find({
      period_type: periodType,
      period_start: { $gte: periodStart },
      period_end: { $lte: periodEnd },
      status: 'paid'
    })
    .populate('doctor_id', 'firstName lastName paymentType amount isFullTime')
    .sort({ paid_date: -1 });

    const summary = await Salary.aggregate([
      {
        $match: {
          period_type: periodType,
          period_start: { $gte: periodStart },
          period_end: { $lte: periodEnd },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: {
            doctor_id: '$doctor_id',
            paymentType: '$doctor_id.paymentType'
          },
          totalAmount: { $sum: '$net_amount' },
          totalAppointments: { $sum: '$appointment_count' },
          paymentCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'doctors',
          localField: '_id.doctor_id',
          foreignField: '_id',
          as: 'doctor'
        }
      },
      { $unwind: '$doctor' }
    ]);

    if (format === 'csv') {
      // Generate CSV format
      let csv = 'Doctor Name,Payment Type,Amount,Appointments,Payment Date\n';
      salaries.forEach(salary => {
        csv += `"${salary.doctor_id.firstName} ${salary.doctor_id.lastName}",${salary.doctor_id.paymentType},${salary.net_amount},${salary.appointment_count},${salary.paid_date.toISOString().split('T')[0]}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=salary-report-${startDate}-to-${endDate}.csv`);
      return res.send(csv);
    }

    res.json({
      period: { start: startDate, end: endDate, type: periodType },
      summary: {
        totalAmount: summary.reduce((sum, item) => sum + item.totalAmount, 0),
        totalAppointments: summary.reduce((sum, item) => sum + item.totalAppointments, 0),
        totalPayments: summary.reduce((sum, item) => sum + item.paymentCount, 0),
        byPaymentType: summary
      },
      detailed: salaries
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};