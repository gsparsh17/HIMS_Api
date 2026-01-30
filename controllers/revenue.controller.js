const Appointment = require('../models/Appointment');
const Salary = require('../models/Salary');
const Invoice = require('../models/Invoice');
const Doctor = require('../models/Doctor');
const Patient = require('../models/Patient');
const mongoose = require('mongoose');

// Enhanced revenue calculation with detailed bifurcation
exports.calculateHospitalRevenue = async (req, res) => {
  try {
    const { 
      startDate, 
      endDate,
      doctorId,
      department,
      patientType,
      invoiceType,
      paymentMethod,
      invoiceStatus,
      minAmount,
      maxAmount
    } = req.query;
    
    // Build date filter
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else {
      // Default to last 30 days if no dates provided
      const now = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(now.getDate() - 30);
      dateFilter.createdAt = {
        $gte: thirtyDaysAgo,
        $lte: now
      };
    }

    // Build base filter
    const baseFilter = { ...dateFilter };
    
    // Apply additional filters
    if (doctorId && doctorId !== 'all') {
      // For invoices with doctor information, we need to check multiple fields
      baseFilter.$or = [
        { 'appointment_id.doctor_id': doctorId },
        { doctor_id: doctorId }
      ];
    }
    
    if (department && department !== 'all') {
      baseFilter.department = department;
    }
    
    if (patientType && patientType !== 'all') {
      baseFilter['patient_id.patient_type'] = patientType;
    }
    
    if (invoiceType && invoiceType !== 'all') {
      baseFilter.invoice_type = invoiceType;
    }
    
    if (paymentMethod && paymentMethod !== 'all') {
      baseFilter['payment_history.method'] = paymentMethod;
    }
    
    if (invoiceStatus && invoiceStatus !== 'all') {
      baseFilter.status = invoiceStatus;
    }

    // Amount range filter
    const amountFilter = {};
    if (minAmount) {
      amountFilter.total = { $gte: parseFloat(minAmount) };
    }
    if (maxAmount) {
      amountFilter.total = { ...amountFilter.total, $lte: parseFloat(maxAmount) };
    }

    // Fetch invoices with detailed breakdown
    const invoices = await Invoice.aggregate([
      {
        $match: {
          ...baseFilter,
          ...(Object.keys(amountFilter).length > 0 ? amountFilter : {})
        }
      },
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient_info'
        }
      },
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      {
        $unwind: {
          path: '$patient_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: '$appointment_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $addFields: {
          patient_type: '$patient_info.patient_type',
          doctor_id: '$appointment_info.doctor_id'
        }
      }
    ]);

    // Calculate detailed statistics
    let totalRevenue = 0;
    let appointmentRevenue = 0;
    let pharmacyRevenue = 0;
    let procedureRevenue = 0;
    let otherRevenue = 0;
    
    const doctorRevenue = {};
    const departmentRevenue = {};
    const patientRevenue = {};
    const dailyRevenue = {};
    
    let totalInvoices = 0;
    let appointmentCount = 0;
    let pharmacyCount = 0;
    let procedureCount = 0;
    let paidAmount = 0;
    let pendingAmount = 0;
    
    const uniquePatients = new Set();
    const uniqueDoctors = new Set();
    const paymentMethods = {};
    
    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const amountPaid = invoice.amount_paid || 0;
      const balanceDue = invoice.balance_due || 0;
      
      totalRevenue += amount;
      totalInvoices++;
      
      // Categorize by invoice type
      switch (invoice.invoice_type) {
        case 'Appointment':
          appointmentRevenue += amount;
          appointmentCount++;
          break;
        case 'Pharmacy':
          pharmacyRevenue += amount;
          pharmacyCount++;
          break;
        case 'Procedure':
          procedureRevenue += amount;
          procedureCount++;
          break;
        default:
          otherRevenue += amount;
      }
      
      // Track payment status
      paidAmount += amountPaid;
      pendingAmount += balanceDue;
      
      // Track by doctor
      if (invoice.doctor_id) {
        const doctorId = invoice.doctor_id.toString();
        uniqueDoctors.add(doctorId);
        doctorRevenue[doctorId] = (doctorRevenue[doctorId] || 0) + amount;
      }
      
      // Track by patient
      if (invoice.patient_id) {
        const patientId = invoice.patient_id.toString();
        uniquePatients.add(patientId);
        patientRevenue[patientId] = (patientRevenue[patientId] || 0) + amount;
      }
      
      // Track daily revenue
      const date = new Date(invoice.createdAt).toISOString().split('T')[0];
      dailyRevenue[date] = (dailyRevenue[date] || 0) + amount;
      
      // Track payment methods
      if (invoice.payment_history && invoice.payment_history.length > 0) {
        invoice.payment_history.forEach(payment => {
          const method = payment.method || 'Unknown';
          paymentMethods[method] = (paymentMethods[method] || 0) + payment.amount;
        });
      }
    });

    // Calculate salary expenses for the period
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          paid_date: dateFilter.createdAt || {
            $gte: new Date(),
            $lte: new Date()
          },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: '$net_amount' },
          salaryCount: { $sum: 1 },
          byDoctor: {
            $push: {
              doctor_id: '$doctor_id',
              amount: '$net_amount'
            }
          }
        }
      }
    ]);

    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - totalSalaryExpenses;
    
    // Get top performing doctors
    const topDoctors = await Promise.all(
      Object.entries(doctorRevenue)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(async ([doctorId, revenue]) => {
          const doctor = await Doctor.findById(doctorId);
          return {
            doctorId,
            name: doctor ? `${doctor.firstName} ${doctor.lastName}` : 'Unknown',
            revenue,
            department: doctor?.department || 'Unknown',
            specialization: doctor?.specialization || 'N/A'
          };
        })
    );

    // Get top patients
    const topPatients = await Promise.all(
      Object.entries(patientRevenue)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(async ([patientId, revenue]) => {
          const patient = await Patient.findById(patientId);
          return {
            patientId,
            name: patient ? `${patient.first_name} ${patient.last_name}` : 'Unknown',
            revenue,
            type: patient?.patient_type || 'Unknown',
            visits: invoices.filter(inv => inv.patient_id?.toString() === patientId).length
          };
        })
    );

    // Calculate daily breakdown for chart
    const dailyBreakdown = Object.entries(dailyRevenue)
      .sort(([dateA], [dateB]) => new Date(dateA) - new Date(dateB))
      .map(([date, revenue]) => ({
        date,
        revenue,
        appointments: invoices
          .filter(inv => 
            new Date(inv.createdAt).toISOString().split('T')[0] === date && 
            inv.invoice_type === 'Appointment'
          ).length,
        pharmacy: invoices
          .filter(inv => 
            new Date(inv.createdAt).toISOString().split('T')[0] === date && 
            inv.invoice_type === 'Pharmacy'
          ).length
      }));

    // Calculate payment method breakdown
    const paymentMethodBreakdown = Object.entries(paymentMethods).map(([method, amount]) => ({
      method,
      amount,
      percentage: totalRevenue > 0 ? (amount / totalRevenue * 100).toFixed(2) : 0
    }));

    res.json({
      period: {
        start: dateFilter.createdAt?.$gte || new Date(),
        end: dateFilter.createdAt?.$lte || new Date()
      },
      summary: {
        totalRevenue,
        appointmentRevenue,
        pharmacyRevenue,
        procedureRevenue,
        otherRevenue,
        totalSalaryExpenses,
        netRevenue,
        collectionRate: totalRevenue > 0 ? (paidAmount / totalRevenue * 100) : 0,
        pendingRate: totalRevenue > 0 ? (pendingAmount / totalRevenue * 100) : 0
      },
      counts: {
        totalInvoices,
        appointments: appointmentCount,
        pharmacySales: pharmacyCount,
        procedures: procedureCount,
        uniquePatients: uniquePatients.size,
        uniqueDoctors: uniqueDoctors.size,
        salariesPaid: salaryExpenses[0]?.salaryCount || 0
      },
      breakdown: {
        bySource: {
          appointments: {
            amount: appointmentRevenue,
            percentage: totalRevenue > 0 ? (appointmentRevenue / totalRevenue * 100).toFixed(2) : 0,
            count: appointmentCount,
            average: appointmentCount > 0 ? (appointmentRevenue / appointmentCount).toFixed(2) : 0
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? (pharmacyRevenue / totalRevenue * 100).toFixed(2) : 0,
            count: pharmacyCount,
            average: pharmacyCount > 0 ? (pharmacyRevenue / pharmacyCount).toFixed(2) : 0
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? (procedureRevenue / totalRevenue * 100).toFixed(2) : 0,
            count: procedureCount,
            average: procedureCount > 0 ? (procedureRevenue / procedureCount).toFixed(2) : 0
          }
        },
        byStatus: {
          paid: {
            amount: paidAmount,
            invoices: invoices.filter(inv => inv.status === 'Paid').length
          },
          pending: {
            amount: pendingAmount,
            invoices: invoices.filter(inv => inv.status !== 'Paid').length
          }
        },
        byPaymentMethod: paymentMethodBreakdown,
        daily: dailyBreakdown
      },
      topPerformers: {
        doctors: topDoctors,
        patients: topPatients
      },
      metrics: {
        profitMargin: totalRevenue > 0 ? (netRevenue / totalRevenue * 100).toFixed(2) : 0,
        expenseRatio: totalRevenue > 0 ? (totalSalaryExpenses / totalRevenue * 100).toFixed(2) : 0,
        averageInvoiceValue: totalInvoices > 0 ? (totalRevenue / totalInvoices).toFixed(2) : 0,
        averageDailyRevenue: dailyBreakdown.length > 0 ? 
          (totalRevenue / dailyBreakdown.length).toFixed(2) : 0,
        busiestDay: dailyBreakdown.reduce((max, day) => 
          day.revenue > max.revenue ? day : max, { revenue: 0 }
        )
      }
    });
  } catch (error) {
    console.error('Error calculating hospital revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

// Enhanced daily revenue report
exports.getDailyRevenueReport = async (req, res) => {
  try {
    const { 
      date, 
      doctorId,
      department,
      invoiceType,
      paymentMethod 
    } = req.query;
    
    let targetDate;
    if (date) {
      targetDate = new Date(`${date}T00:00:00.000Z`);
    } else {
      const now = new Date();
      targetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }

    const startOfDay = targetDate;
    const endOfDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000 - 1);

    // Build filter
    const filter = {
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    };

    if (doctorId && doctorId !== 'all') {
      filter.$or = [
        { 'appointment_id.doctor_id': doctorId },
        { doctor_id: doctorId }
      ];
    }

    if (department && department !== 'all') {
      filter.department = department;
    }

    if (invoiceType && invoiceType !== 'all') {
      filter.invoice_type = invoiceType;
    }

    if (paymentMethod && paymentMethod !== 'all') {
      filter['payment_history.method'] = paymentMethod;
    }

    // Get detailed invoice data for the day
    const invoices = await Invoice.aggregate([
      {
        $match: filter
      },
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient_info'
        }
      },
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      {
        $unwind: {
          path: '$patient_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: '$appointment_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'doctors',
          localField: 'appointment_info.doctor_id',
          foreignField: '_id',
          as: 'doctor_info'
        }
      },
      {
        $unwind: {
          path: '$doctor_info',
          preserveNullAndEmptyArrays: true
        }
      }
    ]);

    // Calculate daily statistics
    let totalRevenue = 0;
    let appointmentRevenue = 0;
    let pharmacyRevenue = 0;
    let procedureRevenue = 0;
    
    let appointmentCount = 0;
    let pharmacyCount = 0;
    let procedureCount = 0;
    
    const doctorBreakdown = {};
    const departmentBreakdown = {};
    const hourlyRevenue = Array(24).fill(0);
    const paymentMethodBreakdown = {};

    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const hour = new Date(invoice.createdAt).getHours();
      
      totalRevenue += amount;
      
      // Categorize by invoice type
      switch (invoice.invoice_type) {
        case 'Appointment':
          appointmentRevenue += amount;
          appointmentCount++;
          break;
        case 'Pharmacy':
          pharmacyRevenue += amount;
          pharmacyCount++;
          break;
        case 'Procedure':
          procedureRevenue += amount;
          procedureCount++;
          break;
      }
      
      // Track by doctor
      if (invoice.appointment_info?.doctor_id) {
        const doctorId = invoice.appointment_info.doctor_id.toString();
        const doctorName = invoice.doctor_info ? 
          `${invoice.doctor_info.firstName} ${invoice.doctor_info.lastName}` : 'Unknown';
        
        if (!doctorBreakdown[doctorId]) {
          doctorBreakdown[doctorId] = {
            name: doctorName,
            revenue: 0,
            appointments: 0,
            department: invoice.doctor_info?.department || 'Unknown'
          };
        }
        
        doctorBreakdown[doctorId].revenue += amount;
        doctorBreakdown[doctorId].appointments++;
      }
      
      // Track by department
      const department = invoice.doctor_info?.department || 'Unknown';
      departmentBreakdown[department] = (departmentBreakdown[department] || 0) + amount;
      
      // Track hourly revenue
      hourlyRevenue[hour] += amount;
      
      // Track payment methods
      if (invoice.payment_history && invoice.payment_history.length > 0) {
        invoice.payment_history.forEach(payment => {
          const method = payment.method || 'Unknown';
          paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + payment.amount;
        });
      }
    });

    // Get salary expenses for the day
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          paid_date: { $gte: startOfDay, $lte: endOfDay },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: '$net_amount' },
          byDoctor: {
            $push: {
              doctor_id: '$doctor_id',
              amount: '$net_amount'
            }
          }
        }
      }
    ]);

    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - totalSalaryExpenses;

    // Convert doctor breakdown to array
    const doctorBreakdownArray = Object.values(doctorBreakdown)
      .sort((a, b) => b.revenue - a.revenue);

    // Convert department breakdown to array
    const departmentBreakdownArray = Object.entries(departmentBreakdown)
      .map(([name, revenue]) => ({
        name,
        revenue,
        percentage: totalRevenue > 0 ? (revenue / totalRevenue * 100).toFixed(2) : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Convert payment method breakdown to array
    const paymentMethodArray = Object.entries(paymentMethodBreakdown)
      .map(([method, amount]) => ({
        method,
        amount,
        percentage: totalRevenue > 0 ? (amount / totalRevenue * 100).toFixed(2) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

    res.json({
      date: startOfDay.toISOString().split('T')[0],
      summary: {
        totalRevenue,
        appointmentRevenue,
        pharmacyRevenue,
        procedureRevenue,
        totalSalaryExpenses,
        netRevenue,
        profitMargin: totalRevenue > 0 ? (netRevenue / totalRevenue * 100).toFixed(2) : 0
      },
      counts: {
        totalInvoices: invoices.length,
        appointments: appointmentCount,
        pharmacySales: pharmacyCount,
        procedures: procedureCount
      },
      breakdown: {
        bySource: {
          appointments: {
            amount: appointmentRevenue,
            percentage: totalRevenue > 0 ? (appointmentRevenue / totalRevenue * 100).toFixed(2) : 0,
            average: appointmentCount > 0 ? (appointmentRevenue / appointmentCount).toFixed(2) : 0
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? (pharmacyRevenue / totalRevenue * 100).toFixed(2) : 0,
            average: pharmacyCount > 0 ? (pharmacyRevenue / pharmacyCount).toFixed(2) : 0
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? (procedureRevenue / totalRevenue * 100).toFixed(2) : 0,
            average: procedureCount > 0 ? (procedureRevenue / procedureCount).toFixed(2) : 0
          }
        },
        byDoctor: doctorBreakdownArray,
        byDepartment: departmentBreakdownArray,
        byHour: hourlyRevenue.map((revenue, hour) => ({
          hour: `${hour.toString().padStart(2, '0')}:00`,
          revenue,
          percentage: totalRevenue > 0 ? (revenue / totalRevenue * 100).toFixed(2) : 0
        })),
        byPaymentMethod: paymentMethodArray
      },
      metrics: {
        busiestHour: hourlyRevenue.reduce((maxIdx, revenue, idx) => 
          revenue > hourlyRevenue[maxIdx] ? idx : maxIdx, 0
        ),
        averageInvoiceValue: invoices.length > 0 ? (totalRevenue / invoices.length).toFixed(2) : 0,
        peakRevenueHour: {
          hour: hourlyRevenue.reduce((maxIdx, revenue, idx) => 
            revenue > hourlyRevenue[maxIdx] ? idx : maxIdx, 0
          ),
          revenue: Math.max(...hourlyRevenue)
        }
      },
      invoices: invoices.map(inv => ({
        invoice_number: inv.invoice_number,
        type: inv.invoice_type,
        patient: inv.patient_info ? 
          `${inv.patient_info.first_name} ${inv.patient_info.last_name}` : 'Unknown',
        doctor: inv.doctor_info ? 
          `${inv.doctor_info.firstName} ${inv.doctor_info.lastName}` : 'Unknown',
        amount: inv.total,
        status: inv.status,
        payment_method: inv.payment_history && inv.payment_history.length > 0 ? 
          inv.payment_history[inv.payment_history.length - 1].method : 'Unknown',
        time: new Date(inv.createdAt).toLocaleTimeString()
      }))
    });
  } catch (error) {
    console.error('Error getting daily revenue report:', error);
    res.status(500).json({ error: error.message });
  }
};

// Enhanced monthly revenue report
exports.getMonthlyRevenueReport = async (req, res) => {
  try {
    const { 
      year, 
      month,
      doctorId,
      department,
      invoiceType,
      paymentMethod,
      patientType 
    } = req.query;
    
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;

    const startOfMonth = new Date(targetYear, targetMonth - 1, 1);
    const endOfMonth = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

    // Build filter
    const filter = {
      createdAt: { $gte: startOfMonth, $lte: endOfMonth }
    };

    if (doctorId && doctorId !== 'all') {
      filter.$or = [
        { 'appointment_id.doctor_id': doctorId },
        { doctor_id: doctorId }
      ];
    }

    if (department && department !== 'all') {
      filter.department = department;
    }

    if (invoiceType && invoiceType !== 'all') {
      filter.invoice_type = invoiceType;
    }

    if (paymentMethod && paymentMethod !== 'all') {
      filter['payment_history.method'] = paymentMethod;
    }

    // Get invoices for the month
    const invoices = await Invoice.aggregate([
      {
        $match: filter
      },
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient_info'
        }
      },
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      {
        $unwind: {
          path: '$patient_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $unwind: {
          path: '$appointment_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $addFields: {
          dayOfMonth: { $dayOfMonth: '$createdAt' },
          patient_type: '$patient_info.patient_type'
        }
      }
    ]);

    // Apply patient type filter if specified
    let filteredInvoices = invoices;
    if (patientType && patientType !== 'all') {
      filteredInvoices = invoices.filter(inv => inv.patient_type === patientType);
    }

    // Calculate monthly statistics
    let totalRevenue = 0;
    let appointmentRevenue = 0;
    let pharmacyRevenue = 0;
    let procedureRevenue = 0;
    
    let appointmentCount = 0;
    let pharmacyCount = 0;
    let procedureCount = 0;
    
    const dailyBreakdown = {};
    const weeklyBreakdown = {};
    const doctorBreakdown = {};
    const patientBreakdown = {};
    const paymentMethodBreakdown = {};

    filteredInvoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const day = invoice.dayOfMonth;
      const week = Math.ceil(day / 7);
      
      totalRevenue += amount;
      
      // Categorize by invoice type
      switch (invoice.invoice_type) {
        case 'Appointment':
          appointmentRevenue += amount;
          appointmentCount++;
          break;
        case 'Pharmacy':
          pharmacyRevenue += amount;
          pharmacyCount++;
          break;
        case 'Procedure':
          procedureRevenue += amount;
          procedureCount++;
          break;
      }
      
      // Track daily breakdown
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = {
          date: new Date(targetYear, targetMonth - 1, day).toISOString().split('T')[0],
          revenue: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0
        };
      }
      dailyBreakdown[day].revenue += amount;
      
      switch (invoice.invoice_type) {
        case 'Appointment':
          dailyBreakdown[day].appointments++;
          break;
        case 'Pharmacy':
          dailyBreakdown[day].pharmacy++;
          break;
        case 'Procedure':
          dailyBreakdown[day].procedures++;
          break;
      }
      
      // Track weekly breakdown
      if (!weeklyBreakdown[week]) {
        weeklyBreakdown[week] = {
          week,
          startDay: (week - 1) * 7 + 1,
          endDay: Math.min(week * 7, endOfMonth.getDate()),
          revenue: 0,
          appointments: 0,
          pharmacy: 0
        };
      }
      weeklyBreakdown[week].revenue += amount;
      
      // Track by doctor
      if (invoice.appointment_info?.doctor_id) {
        const doctorId = invoice.appointment_info.doctor_id.toString();
        doctorBreakdown[doctorId] = (doctorBreakdown[doctorId] || 0) + amount;
      }
      
      // Track by patient
      if (invoice.patient_id) {
        const patientId = invoice.patient_id.toString();
        patientBreakdown[patientId] = (patientBreakdown[patientId] || 0) + amount;
      }
      
      // Track payment methods
      if (invoice.payment_history && invoice.payment_history.length > 0) {
        invoice.payment_history.forEach(payment => {
          const method = payment.method || 'Unknown';
          paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + payment.amount;
        });
      }
    });

    // Get salary expenses for the month
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          period_start: { $gte: startOfMonth, $lte: endOfMonth },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: '$net_amount' },
          salaryCount: { $sum: 1 },
          byDoctor: {
            $push: {
              doctor_id: '$doctor_id',
              amount: '$net_amount'
            }
          }
        }
      }
    ]);

    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - totalSalaryExpenses;
    
    // Get days with revenue (business days)
    const businessDays = Object.keys(dailyBreakdown).length;
    
    // Find highest revenue day
    let highestRevenueDay = { revenue: 0 };
    Object.values(dailyBreakdown).forEach(day => {
      if (day.revenue > highestRevenueDay.revenue) {
        highestRevenueDay = day;
      }
    });

    // Convert doctor breakdown to array with details
    const doctorDetails = await Promise.all(
      Object.entries(doctorBreakdown)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(async ([doctorId, revenue]) => {
          const doctor = await Doctor.findById(doctorId);
          return {
            doctorId,
            name: doctor ? `${doctor.firstName} ${doctor.lastName}` : 'Unknown',
            revenue,
            appointments: filteredInvoices.filter(inv => 
              inv.appointment_info?.doctor_id?.toString() === doctorId && 
              inv.invoice_type === 'Appointment'
            ).length,
            department: doctor?.department || 'Unknown',
            specialization: doctor?.specialization || 'N/A'
          };
        })
    );

    // Convert patient breakdown to array with details
    const patientDetails = await Promise.all(
      Object.entries(patientBreakdown)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10)
        .map(async ([patientId, revenue]) => {
          const patient = await Patient.findById(patientId);
          return {
            patientId,
            name: patient ? `${patient.first_name} ${patient.last_name}` : 'Unknown',
            revenue,
            visits: filteredInvoices.filter(inv => 
              inv.patient_id?.toString() === patientId
            ).length,
            type: patient?.patient_type || 'Unknown',
            lastVisit: filteredInvoices
              .filter(inv => inv.patient_id?.toString() === patientId)
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
              ?.createdAt
          };
        })
    );

    // Convert daily breakdown to array
    const dailyBreakdownArray = Object.values(dailyBreakdown).sort((a, b) => 
      new Date(a.date) - new Date(b.date)
    );

    // Convert weekly breakdown to array
    const weeklyBreakdownArray = Object.values(weeklyBreakdown).sort((a, b) => a.week - b.week);

    // Convert payment method breakdown to array
    const paymentMethodArray = Object.entries(paymentMethodBreakdown)
      .map(([method, amount]) => ({
        method,
        amount,
        percentage: totalRevenue > 0 ? (amount / totalRevenue * 100).toFixed(2) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

    res.json({
      period: {
        year: targetYear,
        month: targetMonth,
        monthName: new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' }),
        startDate: startOfMonth,
        endDate: endOfMonth
      },
      summary: {
        totalRevenue,
        appointmentRevenue,
        pharmacyRevenue,
        procedureRevenue,
        totalSalaryExpenses,
        netRevenue,
        profitMargin: totalRevenue > 0 ? (netRevenue / totalRevenue * 100).toFixed(2) : 0,
        expenseRatio: totalRevenue > 0 ? (totalSalaryExpenses / totalRevenue * 100).toFixed(2) : 0
      },
      counts: {
        totalInvoices: filteredInvoices.length,
        appointments: appointmentCount,
        pharmacySales: pharmacyCount,
        procedures: procedureCount,
        uniquePatients: Object.keys(patientBreakdown).length,
        uniqueDoctors: Object.keys(doctorBreakdown).length,
        businessDays,
        salariesPaid: salaryExpenses[0]?.salaryCount || 0
      },
      breakdown: {
        bySource: {
          appointments: {
            amount: appointmentRevenue,
            percentage: totalRevenue > 0 ? (appointmentRevenue / totalRevenue * 100).toFixed(2) : 0,
            count: appointmentCount,
            average: appointmentCount > 0 ? (appointmentRevenue / appointmentCount).toFixed(2) : 0
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? (pharmacyRevenue / totalRevenue * 100).toFixed(2) : 0,
            count: pharmacyCount,
            average: pharmacyCount > 0 ? (pharmacyRevenue / pharmacyCount).toFixed(2) : 0
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? (procedureRevenue / totalRevenue * 100).toFixed(2) : 0,
            count: procedureCount,
            average: procedureCount > 0 ? (procedureRevenue / procedureCount).toFixed(2) : 0
          }
        },
        daily: dailyBreakdownArray,
        weekly: weeklyBreakdownArray,
        byDoctor: doctorDetails,
        byPatient: patientDetails,
        byPaymentMethod: paymentMethodArray
      },
      metrics: {
        averageDailyRevenue: businessDays > 0 ? (totalRevenue / businessDays).toFixed(2) : 0,
        highestRevenueDay,
        averageInvoiceValue: filteredInvoices.length > 0 ? 
          (totalRevenue / filteredInvoices.length).toFixed(2) : 0,
        revenueGrowth: null, // Would need previous month data
        patientVisitFrequency: Object.keys(patientBreakdown).length > 0 ? 
          (appointmentCount / Object.keys(patientBreakdown).length).toFixed(2) : 0
      },
      trends: {
        weeklyTrend: weeklyBreakdownArray.map(week => week.revenue),
        sourceTrend: {
          appointments: dailyBreakdownArray.map(day => day.appointments),
          pharmacy: dailyBreakdownArray.map(day => day.pharmacy),
          procedures: dailyBreakdownArray.map(day => day.procedures)
        }
      }
    });
  } catch (error) {
    console.error('Error getting monthly revenue report:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get revenue by doctor
exports.getDoctorRevenue = async (req, res) => {
  try {
    const { 
      doctorId,
      startDate,
      endDate,
      invoiceType 
    } = req.query;

    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else {
      // Default to last 30 days
      const now = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(now.getDate() - 30);
      dateFilter.createdAt = {
        $gte: thirtyDaysAgo,
        $lte: now
      };
    }

    const filter = {
      ...dateFilter,
      $or: [
        { 'appointment_id.doctor_id': doctorId },
        { doctor_id: doctorId }
      ]
    };

    if (invoiceType && invoiceType !== 'all') {
      filter.invoice_type = invoiceType;
    }

    const invoices = await Invoice.aggregate([
      {
        $match: filter
      },
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      {
        $unwind: {
          path: '$appointment_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient_info'
        }
      },
      {
        $unwind: {
          path: '$patient_info',
          preserveNullAndEmptyArrays: true
        }
      }
    ]);

    // Calculate doctor-specific statistics
    let totalRevenue = 0;
    let appointmentCount = 0;
    let procedureCount = 0;
    const dailyRevenue = {};
    const patientBreakdown = {};
    const serviceBreakdown = {};

    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const date = new Date(invoice.createdAt).toISOString().split('T')[0];
      
      totalRevenue += amount;
      
      if (invoice.invoice_type === 'Appointment') {
        appointmentCount++;
      } else if (invoice.invoice_type === 'Procedure') {
        procedureCount++;
      }
      
      // Track daily revenue
      dailyRevenue[date] = (dailyRevenue[date] || 0) + amount;
      
      // Track patient breakdown
      if (invoice.patient_id) {
        const patientId = invoice.patient_id.toString();
        if (!patientBreakdown[patientId]) {
          patientBreakdown[patientId] = {
            id: patientId,
            name: `${invoice.patient_info.first_name} ${invoice.patient_info.last_name}`,
            revenue: 0,
            visits: 0
          };
        }
        patientBreakdown[patientId].revenue += amount;
        patientBreakdown[patientId].visits++;
      }
      
      // Track service breakdown
      if (invoice.service_items && invoice.service_items.length > 0) {
        invoice.service_items.forEach(item => {
          const serviceType = item.service_type || 'Other';
          serviceBreakdown[serviceType] = (serviceBreakdown[serviceType] || 0) + item.total_price;
        });
      }
    });

    // Get doctor details
    const doctor = await Doctor.findById(doctorId);
    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    // Convert breakdowns to arrays
    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([date, revenue]) => ({ date, revenue }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const patientBreakdownArray = Object.values(patientBreakdown)
      .sort((a, b) => b.revenue - a.revenue);

    const serviceBreakdownArray = Object.entries(serviceBreakdown)
      .map(([service, revenue]) => ({
        service,
        revenue,
        percentage: totalRevenue > 0 ? (revenue / totalRevenue * 100).toFixed(2) : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      doctor: {
        id: doctor._id,
        name: `${doctor.firstName} ${doctor.lastName}`,
        department: doctor.department,
        specialization: doctor.specialization,
        licenseNumber: doctor.licenseNumber
      },
      period: {
        start: dateFilter.createdAt?.$gte || new Date(),
        end: dateFilter.createdAt?.$lte || new Date()
      },
      summary: {
        totalRevenue,
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
        uniquePatients: Object.keys(patientBreakdown).length,
        averageRevenuePerPatient: Object.keys(patientBreakdown).length > 0 ?
          (totalRevenue / Object.keys(patientBreakdown).length).toFixed(2) : 0,
        averageRevenuePerVisit: invoices.length > 0 ?
          (totalRevenue / invoices.length).toFixed(2) : 0
      },
      breakdown: {
        daily: dailyBreakdown,
        byPatient: patientBreakdownArray,
        byService: serviceBreakdownArray
      },
      performance: {
        busiestDay: dailyBreakdown.reduce((max, day) => 
          day.revenue > max.revenue ? day : max, { revenue: 0 }
        ),
        topPatient: patientBreakdownArray.length > 0 ? patientBreakdownArray[0] : null,
        mostPerformedService: serviceBreakdownArray.length > 0 ? serviceBreakdownArray[0] : null
      }
    });
  } catch (error) {
    console.error('Error getting doctor revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get revenue by department
exports.getDepartmentRevenue = async (req, res) => {
  try {
    const { 
      department,
      startDate,
      endDate 
    } = req.query;

    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    // First get all doctors in the department
    const doctors = await Doctor.find({ department });
    const doctorIds = doctors.map(doctor => doctor._id);

    // Get invoices for doctors in this department
    const invoices = await Invoice.aggregate([
      {
        $match: {
          ...dateFilter,
          'appointment_id.doctor_id': { $in: doctorIds }
        }
      },
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      {
        $unwind: {
          path: '$appointment_info',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $lookup: {
          from: 'doctors',
          localField: 'appointment_info.doctor_id',
          foreignField: '_id',
          as: 'doctor_info'
        }
      },
      {
        $unwind: {
          path: '$doctor_info',
          preserveNullAndEmptyArrays: true
        }
      }
    ]);

    // Calculate department statistics
    let totalRevenue = 0;
    let appointmentCount = 0;
    let procedureCount = 0;
    const doctorBreakdown = {};
    const dailyRevenue = {};

    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const date = new Date(invoice.createdAt).toISOString().split('T')[0];
      const doctorId = invoice.appointment_info?.doctor_id;
      
      totalRevenue += amount;
      
      if (invoice.invoice_type === 'Appointment') {
        appointmentCount++;
      } else if (invoice.invoice_type === 'Procedure') {
        procedureCount++;
      }
      
      // Track daily revenue
      dailyRevenue[date] = (dailyRevenue[date] || 0) + amount;
      
      // Track doctor breakdown
      if (doctorId) {
        const doctor = invoice.doctor_info;
        const doctorName = `${doctor.firstName} ${doctor.lastName}`;
        
        if (!doctorBreakdown[doctorId]) {
          doctorBreakdown[doctorId] = {
            id: doctorId,
            name: doctorName,
            revenue: 0,
            appointments: 0,
            specialization: doctor.specialization
          };
        }
        
        doctorBreakdown[doctorId].revenue += amount;
        doctorBreakdown[doctorId].appointments++;
      }
    });

    // Convert breakdowns to arrays
    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([date, revenue]) => ({ date, revenue }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const doctorBreakdownArray = Object.values(doctorBreakdown)
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      department,
      period: {
        start: dateFilter.createdAt?.$gte || new Date(),
        end: dateFilter.createdAt?.$lte || new Date()
      },
      summary: {
        totalRevenue,
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
        totalDoctors: doctorIds.length,
        activeDoctors: Object.keys(doctorBreakdown).length,
        averageRevenuePerDoctor: Object.keys(doctorBreakdown).length > 0 ?
          (totalRevenue / Object.keys(doctorBreakdown).length).toFixed(2) : 0
      },
      breakdown: {
        daily: dailyBreakdown,
        byDoctor: doctorBreakdownArray
      },
      doctors: doctors.map(doctor => ({
        id: doctor._id,
        name: `${doctor.firstName} ${doctor.lastName}`,
        specialization: doctor.specialization,
        revenue: doctorBreakdown[doctor._id]?.revenue || 0,
        appointments: doctorBreakdown[doctor._id]?.appointments || 0
      }))
    });
  } catch (error) {
    console.error('Error getting department revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get detailed transaction report
exports.getDetailedRevenueReport = async (req, res) => {
  try {
    const { 
      startDate,
      endDate,
      doctorId,
      department,
      invoiceType,
      status,
      minAmount,
      maxAmount,
      page = 1,
      limit = 50
    } = req.query;

    const skip = (page - 1) * limit;

    // Build filter
    const filter = {};

    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    if (doctorId && doctorId !== 'all') {
      filter.$or = [
        { 'appointment_id.doctor_id': doctorId },
        { doctor_id: doctorId }
      ];
    }

    if (department && department !== 'all') {
      // Need to join with doctors to filter by department
      // This would require a more complex query
    }

    if (invoiceType && invoiceType !== 'all') {
      filter.invoice_type = invoiceType;
    }

    if (status && status !== 'all') {
      filter.status = status;
    }

    // Amount range filter
    const amountFilter = {};
    if (minAmount) {
      amountFilter.total = { $gte: parseFloat(minAmount) };
    }
    if (maxAmount) {
      amountFilter.total = { ...amountFilter.total, $lte: parseFloat(maxAmount) };
    }

    // Get invoices with populated data
    const [invoices, total] = await Promise.all([
      Invoice.aggregate([
        {
          $match: {
            ...filter,
            ...(Object.keys(amountFilter).length > 0 ? amountFilter : {})
          }
        },
        {
          $lookup: {
            from: 'patients',
            localField: 'patient_id',
            foreignField: '_id',
            as: 'patient_info'
          }
        },
        {
          $lookup: {
            from: 'appointments',
            localField: 'appointment_id',
            foreignField: '_id',
            as: 'appointment_info'
          }
        },
        {
          $lookup: {
            from: 'doctors',
            localField: 'appointment_info.doctor_id',
            foreignField: '_id',
            as: 'doctor_info'
          }
        },
        {
          $unwind: {
            path: '$patient_info',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $unwind: {
            path: '$appointment_info',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $unwind: {
            path: '$doctor_info',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $sort: { createdAt: -1 }
        },
        {
          $skip: skip
        },
        {
          $limit: parseInt(limit)
        },
        {
          $project: {
            invoice_number: 1,
            invoice_type: 1,
            issue_date: 1,
            total: 1,
            amount_paid: 1,
            balance_due: 1,
            status: 1,
            createdAt: 1,
            patient: {
              name: { 
                $concat: [
                  '$patient_info.first_name',
                  ' ',
                  { $ifNull: ['$patient_info.last_name', ''] }
                ]
              },
              patientId: '$patient_info.patientId',
              type: '$patient_info.patient_type'
            },
            doctor: {
              name: {
                $concat: [
                  '$doctor_info.firstName',
                  ' ',
                  { $ifNull: ['$doctor_info.lastName', ''] }
                ]
              },
              department: '$doctor_info.department'
            },
            appointment_date: '$appointment_info.appointment_date',
            payment_method: {
              $arrayElemAt: ['$payment_history.method', -1]
            },
            service_items: 1,
            medicine_items: 1,
            procedure_items: 1,
            notes: 1
          }
        }
      ]),
      Invoice.countDocuments({
        ...filter,
        ...(Object.keys(amountFilter).length > 0 ? amountFilter : {})
      })
    ]);

    // Calculate summary for the filtered data
    const summary = {
      totalRevenue: invoices.reduce((sum, inv) => sum + (inv.total || 0), 0),
      totalPaid: invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0),
      totalPending: invoices.reduce((sum, inv) => sum + (inv.balance_due || 0), 0),
      totalInvoices: invoices.length,
      appointmentCount: invoices.filter(inv => inv.invoice_type === 'Appointment').length,
      pharmacyCount: invoices.filter(inv => inv.invoice_type === 'Pharmacy').length,
      procedureCount: invoices.filter(inv => inv.invoice_type === 'Procedure').length
    };

    res.json({
      period: {
        start: filter.createdAt?.$gte || new Date(),
        end: filter.createdAt?.$lte || new Date()
      },
      summary,
      transactions: invoices,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error getting detailed revenue report:', error);
    res.status(500).json({ error: error.message });
  }
};

// Export revenue data to CSV/Excel
exports.exportRevenueData = async (req, res) => {
  try {
    const { 
      startDate,
      endDate,
      exportType = 'csv' // csv or excel
    } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }

    // Get all invoices for the period
    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId')
      .populate({
        path: 'appointment_id',
        populate: {
          path: 'doctor_id',
          select: 'firstName lastName department'
        }
      })
      .sort({ createdAt: -1 })
      .limit(10000); // Limit for export

    // Prepare data for export
    const exportData = invoices.map(invoice => {
      const doctor = invoice.appointment_id?.doctor_id;
      const patient = invoice.patient_id;
      
      return {
        'Invoice Number': invoice.invoice_number,
        'Date': invoice.issue_date.toISOString().split('T')[0],
        'Type': invoice.invoice_type,
        'Patient Name': patient ? `${patient.first_name} ${patient.last_name}` : 'Unknown',
        'Patient ID': patient?.patientId || 'N/A',
        'Doctor': doctor ? `${doctor.firstName} ${doctor.lastName}` : 'N/A',
        'Department': doctor?.department || 'N/A',
        'Total Amount': invoice.total,
        'Amount Paid': invoice.amount_paid,
        'Balance Due': invoice.balance_due,
        'Status': invoice.status,
        'Payment Method': invoice.payment_history && invoice.payment_history.length > 0 ? 
          invoice.payment_history[invoice.payment_history.length - 1].method : 'N/A',
        'Services Count': invoice.service_items?.length || 0,
        'Medicines Count': invoice.medicine_items?.length || 0,
        'Procedures Count': invoice.procedure_items?.length || 0,
        'Notes': invoice.notes || ''
      };
    });

    // Add summary row
    const summary = {
      'Invoice Number': 'SUMMARY',
      'Date': '',
      'Type': '',
      'Patient Name': '',
      'Patient ID': '',
      'Doctor': '',
      'Department': '',
      'Total Amount': invoices.reduce((sum, inv) => sum + (inv.total || 0), 0),
      'Amount Paid': invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0),
      'Balance Due': invoices.reduce((sum, inv) => sum + (inv.balance_due || 0), 0),
      'Status': '',
      'Payment Method': '',
      'Services Count': invoices.reduce((sum, inv) => sum + (inv.service_items?.length || 0), 0),
      'Medicines Count': invoices.reduce((sum, inv) => sum + (inv.medicine_items?.length || 0), 0),
      'Procedures Count': invoices.reduce((sum, inv) => sum + (inv.procedure_items?.length || 0), 0),
      'Notes': `Total Invoices: ${invoices.length} | Period: ${startDate || 'Start'} to ${endDate || 'End'}`
    };

    exportData.unshift(summary);

    if (exportType === 'excel') {
      // For Excel export, you would use a library like exceljs
      // This is a simplified CSV response
      const csvData = exportData.map(row => 
        Object.values(row).map(value => 
          typeof value === 'string' && value.includes(',') ? `"${value}"` : value
        ).join(',')
      );
      
      const csvHeaders = Object.keys(exportData[0]).join(',');
      const csvContent = [csvHeaders, ...csvData].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=revenue_export_${new Date().getTime()}.csv`);
      res.send(csvContent);
    } else {
      // Return JSON for frontend to handle
      res.json({
        period: {
          start: filter.createdAt?.$gte || new Date(),
          end: filter.createdAt?.$lte || new Date()
        },
        data: exportData,
        total: invoices.length
      });
    }
  } catch (error) {
    console.error('Error exporting revenue data:', error);
    res.status(500).json({ error: error.message });
  }
};