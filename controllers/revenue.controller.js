// controllers/revenue.controller.js - COMPLETE UPDATED VERSION
const Salary = require('../models/Salary');
const Invoice = require('../models/Invoice');
const Doctor = require('../models/Doctor');
const Patient = require('../models/Patient');
const Department = require('../models/Department');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const moment = require('moment');

const toObjectId = (id) => {
  try {
    if (!id) return null;
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
};

/**
 * Helper function to calculate revenue bifurcation
 */
const calculateRevenueBifurcation = (invoices, doctors) => {
  let totalRevenue = 0;
  let doctorRevenue = 0;
  let hospitalRevenue = 0;
  let doctorCommission = 0;
  let fullTimeSalaryExpenses = 0;
  let partTimeDoctorCommission = 0;

  const doctorMap = new Map();
  doctors.forEach(doc => {
    doctorMap.set(doc._id.toString(), {
      name: `${doc.firstName} ${doc.lastName}`,
      revenuePercentage: doc.revenuePercentage || (doc.isFullTime ? 100 : 30),
      isFullTime: doc.isFullTime || false
    });
  });

  invoices.forEach(invoice => {
    const invoiceAmount = invoice.total || 0;
    totalRevenue += invoiceAmount;

    if (invoice.appointment_id?.doctor_id) {
      const doctorId = invoice.appointment_id.doctor_id.toString();
      const doctorInfo = doctorMap.get(doctorId);
      
      if (doctorInfo) {
        const doctorShare = invoiceAmount * (doctorInfo.revenuePercentage / 100);
        const hospitalShare = invoiceAmount - doctorShare;
        
        doctorRevenue += doctorShare;
        hospitalRevenue += hospitalShare;
        
        if (doctorInfo.isFullTime) {
          fullTimeSalaryExpenses += doctorShare;
        } else {
          partTimeDoctorCommission += doctorShare;
          doctorCommission += doctorShare;
        }
      } else {
        // Default split if doctor info not found
        hospitalRevenue += invoiceAmount * 0.7;
        doctorRevenue += invoiceAmount * 0.3;
        doctorCommission += invoiceAmount * 0.3;
        partTimeDoctorCommission += invoiceAmount * 0.3;
      }
    } else {
      // No doctor associated - all to hospital
      hospitalRevenue += invoiceAmount;
    }
  });

  return {
    totalRevenue,
    doctorRevenue,
    hospitalRevenue,
    doctorCommission,
    fullTimeSalaryExpenses,
    partTimeDoctorCommission,
    netHospitalRevenue: hospitalRevenue - fullTimeSalaryExpenses,
    profitMargin: totalRevenue > 0 ? ((hospitalRevenue - fullTimeSalaryExpenses) / totalRevenue) * 100 : 0
  };
};

/**
 * Build invoice aggregation pipeline with correct joins + filters
 */
function buildInvoicePipeline(query, opts = {}) {
  const {
    startDate,
    endDate,
    doctorId,
    departmentId,
    patientType,
    invoiceType,
    paymentMethod,
    invoiceStatus,
    minAmount,
    maxAmount
  } = query;

  const { requireDoctorJoin = false, requirePatientJoin = false } = opts;

  const pipeline = [];

  // Date range (default last 30 days if not provided)
  const dateMatch = {};
  if (startDate && endDate) {
    dateMatch.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') };
  } else {
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - 30);
    dateMatch.createdAt = { $gte: thirtyDaysAgo, $lte: now };
  }

  // Base invoice match (only invoice fields here)
  const match = { ...dateMatch };

  if (invoiceType && invoiceType !== 'all') match.invoice_type = invoiceType;
  if (invoiceStatus && invoiceStatus !== 'all') match.status = invoiceStatus;
  if (paymentMethod && paymentMethod !== 'all') match['payment_history.method'] = paymentMethod;

  if (minAmount || maxAmount) {
    match.total = {};
    if (minAmount) match.total.$gte = parseFloat(minAmount);
    if (maxAmount) match.total.$lte = parseFloat(maxAmount);
  }

  pipeline.push({ $match: match });

  const doctorObjId = doctorId && doctorId !== 'all' ? toObjectId(doctorId) : null;
  const deptObjId = departmentId && departmentId !== 'all' ? toObjectId(departmentId) : null;
  const needsAppointmentJoin = Boolean(doctorObjId || deptObjId || requireDoctorJoin);

  if (needsAppointmentJoin) {
    pipeline.push(
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
      }
    );

    if (doctorObjId) {
      pipeline.push({ $match: { 'appointment_info.doctor_id': doctorObjId } });
    }

    if (deptObjId) {
      pipeline.push(
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
        },
        { $match: { 'doctor_info.department': deptObjId } }
      );
    }
  }

  const needsPatientJoin = Boolean((patientType && patientType !== 'all') || requirePatientJoin);

  if (needsPatientJoin) {
    pipeline.push(
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
    );

    if (patientType && patientType !== 'all') {
      pipeline.push({ $match: { 'patient_info.patient_type': patientType } });
    }
  }

  return {
    pipeline,
    // expose computed period start/end for response
    period: {
      start: dateMatch.createdAt.$gte,
      end: dateMatch.createdAt.$lte
    }
  };
}

/**
 * Enhanced revenue calculation with detailed bifurcation
 */
exports.calculateHospitalRevenue = async (req, res) => {
  try {
    const { pipeline, period } = buildInvoicePipeline(req.query, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure we have doctor_info even if no department filter (for departmentRevenue, doctor stats)
    const hasDoctorInfoStage = pipeline.some(
      (s) => s.$lookup && s.$lookup.from === 'doctors'
    );
    if (!hasDoctorInfoStage) {
      pipeline.push(
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
      );
    }

    // Add computed fields
    pipeline.push({
      $addFields: {
        doctor_id: '$appointment_info.doctor_id',
        patient_type: '$patient_info.patient_type',
        department_id: '$doctor_info.department'
      }
    });

    const invoices = await Invoice.aggregate(pipeline);

    // Get all doctors for bifurcation calculation
    const doctors = await Doctor.find({});
    const bifurcation = calculateRevenueBifurcation(invoices, doctors);

    // Stats accumulators
    let totalRevenue = 0;
    let appointmentRevenue = 0;
    let pharmacyRevenue = 0;
    let procedureRevenue = 0;
    let otherRevenue = 0;

    let totalInvoices = 0;
    let appointmentCount = 0;
    let pharmacyCount = 0;
    let procedureCount = 0;

    let paidAmount = 0;
    let pendingAmount = 0;

    const uniquePatients = new Set();
    const uniqueDoctors = new Set();

    const doctorRevenue = {};      // doctorId -> revenue
    const patientRevenue = {};     // patientId -> revenue
    const departmentRevenue = {};  // departmentId/Unknown -> revenue

    const paymentMethods = {};     // method -> collected amount
    const dailyStats = {};         // date -> {date, revenue, appointments, pharmacy, procedures}

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      const amountPaid = inv.amount_paid || 0;
      const balanceDue = inv.balance_due || 0;

      totalRevenue += amount;
      totalInvoices += 1;
      paidAmount += amountPaid;
      pendingAmount += balanceDue;

      // By source
      switch (inv.invoice_type) {
        case 'Appointment':
          appointmentRevenue += amount;
          appointmentCount += 1;
          break;
        case 'Pharmacy':
          pharmacyRevenue += amount;
          pharmacyCount += 1;
          break;
        case 'Procedure':
          procedureRevenue += amount;
          procedureCount += 1;
          break;
        default:
          otherRevenue += amount;
      }

      // Doctor revenue (from lookup)
      if (inv.doctor_id) {
        const dId = String(inv.doctor_id);
        uniqueDoctors.add(dId);
        doctorRevenue[dId] = (doctorRevenue[dId] || 0) + amount;

        const deptId = inv.department_id ? String(inv.department_id) : 'Unknown';
        departmentRevenue[deptId] = (departmentRevenue[deptId] || 0) + amount;
      } else {
        departmentRevenue['Unknown'] = (departmentRevenue['Unknown'] || 0) + amount;
      }

      // Patient revenue
      if (inv.patient_id) {
        const pId = String(inv.patient_id);
        uniquePatients.add(pId);
        patientRevenue[pId] = (patientRevenue[pId] || 0) + amount;
      }

      // Daily stats (O(N), no invoice re-filter loops)
      const dateKey = new Date(inv.createdAt).toISOString().split('T')[0];
      if (!dailyStats[dateKey]) {
        dailyStats[dateKey] = {
          date: dateKey,
          revenue: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0
        };
      }
      dailyStats[dateKey].revenue += amount;
      if (inv.invoice_type === 'Appointment') dailyStats[dateKey].appointments += 1;
      if (inv.invoice_type === 'Pharmacy') dailyStats[dateKey].pharmacy += 1;
      if (inv.invoice_type === 'Procedure') dailyStats[dateKey].procedures += 1;

      // Payment methods (collections). This sums actual payments, not invoice totals.
      if (Array.isArray(inv.payment_history) && inv.payment_history.length) {
        inv.payment_history.forEach((p) => {
          const method = p.method || 'Unknown';
          paymentMethods[method] = (paymentMethods[method] || 0) + (p.amount || 0);
        });
      }
    });

    // Salary expenses (consistent: paid_date within period)
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          paid_date: { $gte: period.start, $lte: period.end },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: '$net_amount' },
          salaryCount: { $sum: 1 }
        }
      }
    ]);

    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - totalSalaryExpenses;

    // Top doctors (no N+1)
    const topDoctorIds = Object.entries(doctorRevenue)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([id]) => toObjectId(id))
      .filter(Boolean);

    const doctorDocs = topDoctorIds.length
      ? await Doctor.find({ _id: { $in: topDoctorIds } }).select('firstName lastName department specialization revenuePercentage isFullTime')
      : [];
    const doctorMap = new Map(doctorDocs.map((d) => [String(d._id), d]));

    const topDoctors = topDoctorIds.map((id) => {
      const d = doctorMap.get(String(id));
      const revenue = doctorRevenue[String(id)] || 0;
      const commissionPercentage = d?.revenuePercentage || (d?.isFullTime ? 100 : 30);
      const commission = revenue * (commissionPercentage / 100);
      
      return {
        doctorId: String(id),
        name: d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown',
        revenue,
        commission,
        commissionPercentage,
        department: d?.department || 'Unknown',
        specialization: d?.specialization || 'N/A'
      };
    });

    // Top patients (no N+1)
    const topPatientIds = Object.entries(patientRevenue)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([id]) => toObjectId(id))
      .filter(Boolean);

    const patientDocs = topPatientIds.length
      ? await Patient.find({ _id: { $in: topPatientIds } }).select('first_name last_name patient_type')
      : [];
    const patientMap = new Map(patientDocs.map((p) => [String(p._id), p]));

    // visits count: compute once
    const patientVisitCount = {};
    invoices.forEach((inv) => {
      if (!inv.patient_id) return;
      const pId = String(inv.patient_id);
      patientVisitCount[pId] = (patientVisitCount[pId] || 0) + 1;
    });

    const topPatients = topPatientIds.map((id) => {
      const p = patientMap.get(String(id));
      const revenue = patientRevenue[String(id)] || 0;
      return {
        patientId: String(id),
        name: p ? `${p.first_name} ${p.last_name || ''}`.trim() : 'Unknown',
        revenue,
        type: p?.patient_type || 'Unknown',
        visits: patientVisitCount[String(id)] || 0
      };
    });

    const dailyBreakdown = Object.values(dailyStats).sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    // Payment method breakdown: % of collections (paidAmount) is more meaningful
    const paymentMethodBreakdown = Object.entries(paymentMethods)
      .map(([method, amount]) => ({
        method,
        amount,
        percentage: paidAmount > 0 ? Number(((amount / paidAmount) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

    // Better status buckets
    const receivableStatuses = ['Issued', 'Partial', 'Overdue'];
    const excludedStatuses = ['Cancelled', 'Refunded', 'Draft'];

    const statusCounts = invoices.reduce(
      (acc, inv) => {
        const st = inv.status;
        if (st === 'Paid') acc.paidCount += 1;
        else if (receivableStatuses.includes(st)) acc.receivableCount += 1;
        else if (excludedStatuses.includes(st)) acc.excludedCount += 1;
        else acc.otherCount += 1;
        return acc;
      },
      { paidCount: 0, receivableCount: 0, excludedCount: 0, otherCount: 0 }
    );

    res.json({
      period: {
        start: period.start,
        end: period.end
      },
      summary: {
        totalRevenue,
        appointmentRevenue,
        pharmacyRevenue,
        procedureRevenue,
        otherRevenue,
        totalSalaryExpenses,
        netRevenue,
        // Add bifurcation data to summary
        doctorRevenue: bifurcation.doctorRevenue,
        hospitalRevenue: bifurcation.hospitalRevenue,
        doctorCommission: bifurcation.doctorCommission,
        netHospitalRevenue: bifurcation.netHospitalRevenue,
        // collection/pending are based on invoice fields (amount_paid / balance_due)
        collectionRate: totalRevenue > 0 ? (paidAmount / totalRevenue) * 100 : 0,
        pendingRate: totalRevenue > 0 ? (pendingAmount / totalRevenue) * 100 : 0
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
            percentage: totalRevenue > 0 ? Number(((appointmentRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: appointmentCount,
            average: appointmentCount > 0 ? Number((appointmentRevenue / appointmentCount).toFixed(2)) : 0
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? Number(((pharmacyRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: pharmacyCount,
            average: pharmacyCount > 0 ? Number((pharmacyRevenue / pharmacyCount).toFixed(2)) : 0
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? Number(((procedureRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: procedureCount,
            average: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0
          }
        },
        byStatus: {
          paid: {
            amount: paidAmount,
            invoices: statusCounts.paidCount
          },
          receivable: {
            amount: pendingAmount,
            invoices: statusCounts.receivableCount
          },
          excluded: {
            invoices: statusCounts.excludedCount
          }
        },
        byDepartment: Object.entries(departmentRevenue)
          .map(([departmentId, amount]) => ({
            departmentId,
            amount,
            percentage: totalRevenue > 0 ? Number(((amount / totalRevenue) * 100).toFixed(2)) : 0
          }))
          .sort((a, b) => b.amount - a.amount),
        byPaymentMethod: paymentMethodBreakdown,
        daily: dailyBreakdown
      },
      topPerformers: {
        doctors: topDoctors,
        patients: topPatients
      },
      metrics: {
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0,
        expenseRatio: totalRevenue > 0 ? Number(((totalSalaryExpenses / totalRevenue) * 100).toFixed(2)) : 0,
        averageInvoiceValue: totalInvoices > 0 ? Number((totalRevenue / totalInvoices).toFixed(2)) : 0,
        averageDailyRevenue: dailyBreakdown.length > 0 ? Number((totalRevenue / dailyBreakdown.length).toFixed(2)) : 0,
        busiestDay: dailyBreakdown.reduce((max, day) => (day.revenue > max.revenue ? day : max), {
          revenue: 0
        })
      }
    });
  } catch (error) {
    console.error('Error calculating hospital revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Daily revenue report
 */
exports.getDailyRevenueReport = async (req, res) => {
  try {
    const { date, doctorId, departmentId, invoiceType, paymentMethod } = req.query;

    // Build day boundaries in UTC from provided YYYY-MM-DD
    const target = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
    const startOfDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    console.log(`Looking for invoices between: ${startOfDay.toISOString()} and ${endOfDay.toISOString()}`);

    // Create base filter
    const baseFilter = {
      createdAt: { 
        $gte: startOfDay,
        $lte: endOfDay 
      }
    };

    // Add optional filters
    if (invoiceType) {
      baseFilter.invoice_type = invoiceType;
    }
    if (paymentMethod) {
      // This would need adjustment if you want to filter by payment method in history
      console.log('Payment method filtering not fully implemented for payment_history array');
    }

    // Start with simple aggregation to verify data exists
    const dateMatchStage = { $match: baseFilter };

    const pipeline = [
      dateMatchStage,
      {
        $lookup: {
          from: 'appointments',
          let: { appointmentId: '$appointment_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$appointmentId'] } } },
            { $project: { doctor_id: 1, department_id: 1 } }
          ],
          as: 'appointment_info'
        }
      },
      { $unwind: { path: '$appointment_info', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'patients',
          let: { patientId: '$patient_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$patientId'] } } },
            { $project: { first_name: 1, last_name: 1 } }
          ],
          as: 'patient_info'
        }
      },
      { $unwind: { path: '$patient_info', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'doctors',
          let: { doctorId: '$appointment_info.doctor_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$doctorId'] } } },
            { $project: { 
              firstName: 1, 
              lastName: 1, 
              department: 1, 
              revenuePercentage: 1, 
              isFullTime: 1,
              specialization: 1 
            } }
          ],
          as: 'doctor_info'
        }
      },
      { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } }
    ];

    // Add doctor filter if provided
    if (doctorId) {
      pipeline.splice(1, 0, {
        $match: { 'appointment_info.doctor_id': new mongoose.Types.ObjectId(doctorId) }
      });
    }

    // Add department filter if provided
    if (departmentId) {
      pipeline.splice(1, 0, {
        $match: { 'doctor_info.department': new mongoose.Types.ObjectId(departmentId) }
      });
    }

    console.log('Pipeline stages:', JSON.stringify(pipeline, null, 2));

    const invoices = await Invoice.aggregate(pipeline);
    
    // Debug: Log found invoices
    console.log(`Found ${invoices.length} invoices for date ${date}`);
    if (invoices.length > 0) {
      console.log('Sample invoice dates:', invoices.map(inv => ({
        invoice_number: inv.invoice_number,
        createdAt: inv.createdAt,
        total: inv.total
      })));
    }

    const doctors = await Doctor.find({});
    const bifurcation = calculateRevenueBifurcation(invoices, doctors);

    // Debug logging
    console.log(`Daily report - Invoices: ${invoices.length}, Doctors: ${doctors.length}`);
    console.log('Bifurcation:', bifurcation);

    // Rest of your calculation logic...
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

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      const hour = new Date(inv.createdAt).getUTCHours(); // Use UTC hours

      totalRevenue += amount;
      hourlyRevenue[hour] += amount;

      switch (inv.invoice_type) {
        case 'Appointment':
          appointmentRevenue += amount;
          appointmentCount += 1;
          break;
        case 'Pharmacy':
          pharmacyRevenue += amount;
          pharmacyCount += 1;
          break;
        case 'Procedure':
          procedureRevenue += amount;
          procedureCount += 1;
          break;
        default:
          break;
      }

      // Doctor breakdown via appointment_info + doctor_info
      const docId = inv.appointment_info?.doctor_id ? String(inv.appointment_info.doctor_id) : null;
      if (docId) {
        const docName = inv.doctor_info
          ? `${inv.doctor_info.firstName} ${inv.doctor_info.lastName || ''}`.trim()
          : 'Unknown';

        const docCommissionPercent = inv.doctor_info?.revenuePercentage || (inv.doctor_info?.isFullTime ? 100 : 30);
        const docCommission = amount * (docCommissionPercent / 100);

        if (!doctorBreakdown[docId]) {
          doctorBreakdown[docId] = {
            doctorId: docId,
            name: docName,
            revenue: 0,
            commission: 0,
            commissionPercentage: docCommissionPercent,
            invoices: 0,
            department: inv.doctor_info?.department || 'Unknown'
          };
        }
        doctorBreakdown[docId].revenue += amount;
        doctorBreakdown[docId].commission += docCommission;
        doctorBreakdown[docId].invoices += 1;

        const deptKey = inv.doctor_info?.department ? String(inv.doctor_info.department) : 'Unknown';
        if (!departmentBreakdown[deptKey]) {
          departmentBreakdown[deptKey] = {
            departmentId: deptKey,
            revenue: 0,
            commission: 0
          };
        }
        departmentBreakdown[deptKey].revenue += amount;
        departmentBreakdown[deptKey].commission += docCommission;
      } else {
        const deptKey = 'Unknown';
        if (!departmentBreakdown[deptKey]) {
          departmentBreakdown[deptKey] = {
            departmentId: deptKey,
            revenue: 0,
            commission: 0
          };
        }
        departmentBreakdown[deptKey].revenue += amount;
      }

      // Payment methods (collections)
      if (Array.isArray(inv.payment_history) && inv.payment_history.length) {
        inv.payment_history.forEach((p) => {
          const method = p.method || 'Unknown';
          paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + (p.amount || 0);
        });
      }
    });

    // Salary expenses for day
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
          totalExpenses: { $sum: '$net_amount' }
        }
      }
    ]);
    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - totalSalaryExpenses;

    const doctorBreakdownArray = Object.values(doctorBreakdown).sort((a, b) => b.revenue - a.revenue);

    const departmentBreakdownArray = Object.values(departmentBreakdown).map(dept => ({
      ...dept,
      hospitalShare: dept.revenue - dept.commission,
      percentage: totalRevenue > 0 ? Number(((dept.revenue / totalRevenue) * 100).toFixed(2)) : 0
    })).sort((a, b) => b.revenue - a.revenue);

    const totalCollected = Object.values(paymentMethodBreakdown).reduce((s, v) => s + v, 0);
    const paymentMethodArray = Object.entries(paymentMethodBreakdown)
      .map(([method, amount]) => ({
        method,
        amount,
        percentage: totalCollected > 0 ? Number(((amount / totalCollected) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

    const busiestHour = hourlyRevenue.reduce(
      (maxIdx, v, idx) => (v > hourlyRevenue[maxIdx] ? idx : maxIdx),
      0
    );

    res.json({
      date: startOfDay.toISOString().split('T')[0],
      summary: {
        totalRevenue,
        appointmentRevenue,
        pharmacyRevenue,
        procedureRevenue,
        totalSalaryExpenses,
        netRevenue,
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0,
        doctorRevenue: bifurcation?.doctorRevenue || 0,
        hospitalRevenue: bifurcation?.hospitalRevenue || 0,
        doctorCommission: bifurcation?.doctorCommission || 0,
        netHospitalRevenue: bifurcation?.netHospitalRevenue || 0
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
            percentage: totalRevenue > 0 ? Number(((appointmentRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            average: appointmentCount > 0 ? Number((appointmentRevenue / appointmentCount).toFixed(2)) : 0
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? Number(((pharmacyRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            average: pharmacyCount > 0 ? Number((pharmacyRevenue / pharmacyCount).toFixed(2)) : 0
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? Number(((procedureRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            average: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0
          }
        },
        byDoctor: doctorBreakdownArray,
        byDepartment: departmentBreakdownArray,
        byHour: hourlyRevenue.map((revenue, hour) => ({
          hour: `${String(hour).padStart(2, '0')}:00`,
          revenue,
          percentage: totalRevenue > 0 ? Number(((revenue / totalRevenue) * 100).toFixed(2)) : 0
        })),
        byPaymentMethod: paymentMethodArray
      },
      metrics: {
        busiestHour,
        averageInvoiceValue: invoices.length > 0 ? Number((totalRevenue / invoices.length).toFixed(2)) : 0,
        peakRevenueHour: {
          hour: busiestHour,
          revenue: Math.max(...hourlyRevenue)
        }
      },
      invoices: invoices.map((inv) => ({
        invoice_number: inv.invoice_number,
        type: inv.invoice_type,
        patient: inv.patient_info
          ? `${inv.patient_info.first_name} ${inv.patient_info.last_name || ''}`.trim()
          : 'Unknown',
        doctor: inv.doctor_info
          ? `${inv.doctor_info.firstName} ${inv.doctor_info.lastName || ''}`.trim()
          : 'Unknown',
        amount: inv.total,
        status: inv.status,
        payment_method:
          Array.isArray(inv.payment_history) && inv.payment_history.length
            ? inv.payment_history[inv.payment_history.length - 1].method
            : 'Unknown',
        time: new Date(inv.createdAt).toLocaleTimeString()
      }))
    });
  } catch (error) {
    console.error('Error getting daily revenue report:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Monthly revenue report
 */
exports.getMonthlyRevenueReport = async (req, res) => {
  try {
    const { year, month, doctorId, department, invoiceType, paymentMethod, patientType } = req.query;

    const targetYear = parseInt(year, 10) || new Date().getFullYear();
    const targetMonth = parseInt(month, 10) || new Date().getMonth() + 1;

    // Create date range
    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

    // Build query
    const query = {
      createdAt: { $gte: startDate, $lte: endDate }
    };

    // Add filters
    if (invoiceType && invoiceType !== 'all') query.invoice_type = invoiceType;
    if (paymentMethod && paymentMethod !== 'all') query['payment_history.method'] = paymentMethod;

    // Get invoices first
    let invoices = await Invoice.find(query)
      .populate('patient_id', 'first_name last_name patient_type')
      .populate({
        path: 'appointment_id',
        populate: { 
          path: 'doctor_id', 
          select: 'firstName lastName department specialization revenuePercentage isFullTime' 
        }
      });

    console.log(`Found ${invoices.length} invoices for monthly report`);

    // Apply additional filters in JavaScript (simpler approach)
    if (doctorId && doctorId !== 'all') {
      invoices = invoices.filter(inv => 
        inv.appointment_id?.doctor_id?._id.toString() === doctorId
      );
    }

    if (department && department !== 'all') {
      invoices = invoices.filter(inv => 
        inv.appointment_id?.doctor_id?.department?.toString() === department
      );
    }

    if (patientType && patientType !== 'all') {
      invoices = invoices.filter(inv => 
        inv.patient_id?.patient_type === patientType
      );
    }

    // Calculate bifurcation
    const doctors = await Doctor.find({});
    const bifurcation = calculateRevenueBifurcation(invoices, doctors);

    let totalRevenue = 0;
    let appointmentRevenue = 0;
    let pharmacyRevenue = 0;
    let procedureRevenue = 0;

    let appointmentCount = 0;
    let pharmacyCount = 0;
    let procedureCount = 0;

    const dailyBreakdown = {};  // day -> stats
    const weeklyBreakdown = {}; // week -> stats
    const doctorBreakdown = {}; // doctorId -> revenue
    const patientBreakdown = {}; // patientId -> revenue
    const paymentMethodBreakdown = {}; // method -> collected

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      const day = new Date(inv.createdAt).getDate();
      const week = Math.ceil(day / 7);

      totalRevenue += amount;

      switch (inv.invoice_type) {
        case 'Appointment':
          appointmentRevenue += amount;
          appointmentCount += 1;
          break;
        case 'Pharmacy':
          pharmacyRevenue += amount;
          pharmacyCount += 1;
          break;
        case 'Procedure':
          procedureRevenue += amount;
          procedureCount += 1;
          break;
        default:
          break;
      }

      // Daily breakdown
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = {
          date: new Date(Date.UTC(targetYear, targetMonth - 1, day)).toISOString().split('T')[0],
          revenue: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0
        };
      }
      dailyBreakdown[day].revenue += amount;
      if (inv.invoice_type === 'Appointment') dailyBreakdown[day].appointments += 1;
      if (inv.invoice_type === 'Pharmacy') dailyBreakdown[day].pharmacy += 1;
      if (inv.invoice_type === 'Procedure') dailyBreakdown[day].procedures += 1;

      // Weekly breakdown
      if (!weeklyBreakdown[week]) {
        weeklyBreakdown[week] = {
          week,
          startDay: (week - 1) * 7 + 1,
          endDay: Math.min(week * 7, new Date(targetYear, targetMonth, 0).getDate()),
          revenue: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0
        };
      }
      weeklyBreakdown[week].revenue += amount;
      if (inv.invoice_type === 'Appointment') weeklyBreakdown[week].appointments += 1;
      if (inv.invoice_type === 'Pharmacy') weeklyBreakdown[week].pharmacy += 1;
      if (inv.invoice_type === 'Procedure') weeklyBreakdown[week].procedures += 1;

      // Doctor breakdown
      const docId = inv.appointment_id?.doctor_id?._id?.toString();
      if (docId) {
        const doctor = inv.appointment_id.doctor_id;
        const commissionPercent = doctor?.revenuePercentage || (doctor?.isFullTime ? 100 : 30);
        
        if (!doctorBreakdown[docId]) {
          doctorBreakdown[docId] = {
            doctorId: docId,
            name: doctor ? `${doctor.firstName} ${doctor.lastName || ''}`.trim() : 'Unknown',
            revenue: 0,
            commission: 0,
            commissionPercentage: commissionPercent,
            appointments: 0,
            department: doctor?.department || 'Unknown',
            specialization: doctor?.specialization || 'N/A'
          };
        }
        doctorBreakdown[docId].revenue += amount;
        doctorBreakdown[docId].commission += amount * (commissionPercent / 100);
        if (inv.invoice_type === 'Appointment') doctorBreakdown[docId].appointments += 1;
      }

      // Patient breakdown
      if (inv.patient_id) {
        const pId = inv.patient_id._id.toString();
        patientBreakdown[pId] = (patientBreakdown[pId] || 0) + amount;
      }

      // Payment method breakdown
      if (Array.isArray(inv.payment_history) && inv.payment_history.length) {
        inv.payment_history.forEach((p) => {
          const method = p.method || 'Unknown';
          paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + (p.amount || 0);
        });
      }
    });

    // Salary expenses for month
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          paid_date: { $gte: startDate, $lte: endDate },
          status: 'paid'
        }
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: '$net_amount' },
          salaryCount: { $sum: 1 }
        }
      }
    ]);
    
    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - totalSalaryExpenses;
    const businessDays = Object.keys(dailyBreakdown).length;

    let highestRevenueDay = { revenue: 0 };
    Object.values(dailyBreakdown).forEach((d) => {
      if (d.revenue > highestRevenueDay.revenue) highestRevenueDay = d;
    });

    const doctorBreakdownArray = Object.values(doctorBreakdown).sort((a, b) => b.revenue - a.revenue);

    // Patient details
    const topPatientIds = Object.entries(patientBreakdown)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([id]) => toObjectId(id))
      .filter(Boolean);

    const patientDocs = topPatientIds.length
      ? await Patient.find({ _id: { $in: topPatientIds } }).select('first_name last_name patient_type')
      : [];
    const patientMap = new Map(patientDocs.map((p) => [String(p._id), p]));

    // visits and last visit computed once
    const patientVisits = {};
    const patientLastVisit = {};
    invoices.forEach((inv) => {
      if (!inv.patient_id) return;
      const pId = String(inv.patient_id._id);
      patientVisits[pId] = (patientVisits[pId] || 0) + 1;
      const t = new Date(inv.createdAt).getTime();
      if (!patientLastVisit[pId] || t > patientLastVisit[pId]) patientLastVisit[pId] = t;
    });

    const patientDetails = topPatientIds.map((id) => {
      const p = patientMap.get(String(id));
      return {
        patientId: String(id),
        name: p ? `${p.first_name} ${p.last_name || ''}`.trim() : 'Unknown',
        revenue: patientBreakdown[String(id)] || 0,
        visits: patientVisits[String(id)] || 0,
        type: p?.patient_type || 'Unknown',
        lastVisit: patientLastVisit[String(id)] ? new Date(patientLastVisit[String(id)]) : null
      };
    });

    const dailyBreakdownArray = Object.values(dailyBreakdown).sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    
    const weeklyBreakdownArray = Object.values(weeklyBreakdown).sort((a, b) => a.week - b.week);

    const totalCollected = Object.values(paymentMethodBreakdown).reduce((s, v) => s + v, 0);
    const paymentMethodArray = Object.entries(paymentMethodBreakdown)
      .map(([method, amount]) => ({
        method,
        amount,
        percentage: totalCollected > 0 ? Number(((amount / totalCollected) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

    res.json({
      period: {
        year: targetYear,
        month: targetMonth,
        monthName: new Date(Date.UTC(targetYear, targetMonth - 1, 1)).toLocaleString('default', {
          month: 'long'
        }),
        startDate: startDate,
        endDate: endDate
      },
      summary: {
        totalRevenue,
        appointmentRevenue,
        pharmacyRevenue,
        procedureRevenue,
        totalSalaryExpenses,
        netRevenue,
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0,
        expenseRatio: totalRevenue > 0 ? Number(((totalSalaryExpenses / totalRevenue) * 100).toFixed(2)) : 0,
        // Add bifurcation data
        doctorRevenue: bifurcation.doctorRevenue,
        hospitalRevenue: bifurcation.hospitalRevenue,
        doctorCommission: bifurcation.doctorCommission,
        netHospitalRevenue: bifurcation.netHospitalRevenue
      },
      counts: {
        totalInvoices: invoices.length,
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
            percentage: totalRevenue > 0 ? Number(((appointmentRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: appointmentCount,
            average: appointmentCount > 0 ? Number((appointmentRevenue / appointmentCount).toFixed(2)) : 0
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? Number(((pharmacyRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: pharmacyCount,
            average: pharmacyCount > 0 ? Number((pharmacyRevenue / pharmacyCount).toFixed(2)) : 0
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? Number(((procedureRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: procedureCount,
            average: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0
          }
        },
        daily: dailyBreakdownArray,
        weekly: weeklyBreakdownArray,
        byDoctor: doctorBreakdownArray,
        byPatient: patientDetails,
        byPaymentMethod: paymentMethodArray
      },
      metrics: {
        averageDailyRevenue: businessDays > 0 ? Number((totalRevenue / businessDays).toFixed(2)) : 0,
        highestRevenueDay,
        averageInvoiceValue: invoices.length > 0 ? Number((totalRevenue / invoices.length).toFixed(2)) : 0,
        revenueGrowth: null,
        patientVisitFrequency:
          Object.keys(patientBreakdown).length > 0
            ? Number((appointmentCount / Object.keys(patientBreakdown).length).toFixed(2))
            : 0
      },
      trends: {
        weeklyTrend: weeklyBreakdownArray.map((w) => w.revenue),
        sourceTrend: {
          appointments: dailyBreakdownArray.map((d) => d.appointments),
          pharmacy: dailyBreakdownArray.map((d) => d.pharmacy),
          procedures: dailyBreakdownArray.map((d) => d.procedures)
        }
      }
    });
  } catch (error) {
    console.error('Error getting monthly revenue report:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Doctor revenue report
 */
exports.getDoctorRevenue = async (req, res) => {
  try {
    const { doctorId, startDate, endDate, invoiceType } = req.query;

    const doctorObjId = toObjectId(doctorId);
    if (!doctorObjId) return res.status(400).json({ error: 'Invalid doctorId' });

    // Default last 30 days if no dates
    let start = startDate ? new Date(startDate) : null;
    let end = endDate ? new Date(endDate + 'T23:59:59.999Z') : null;

    if (!start || !end) {
      const now = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(now.getDate() - 30);
      start = thirtyDaysAgo;
      end = now;
    }

    const pipeline = [];

    // invoice-only match first
    const match = { createdAt: { $gte: start, $lte: end } };
    if (invoiceType && invoiceType !== 'all') match.invoice_type = invoiceType;
    pipeline.push({ $match: match });

    // join appointment and match doctor
    pipeline.push(
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      { $unwind: { path: '$appointment_info', preserveNullAndEmptyArrays: true } },
      { $match: { 'appointment_info.doctor_id': doctorObjId } }
    );

    // patient lookup for breakdown names
    pipeline.push(
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient_info'
        }
      },
      { $unwind: { path: '$patient_info', preserveNullAndEmptyArrays: true } }
    );

    const invoices = await Invoice.aggregate(pipeline);

    const doctor = await Doctor.findById(doctorObjId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const commissionPercentage = doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30);
    
    let totalRevenue = 0;
    let appointmentCount = 0;
    let procedureCount = 0;
    let pharmacyCount = 0;

    const dailyRevenue = {};
    const patientBreakdown = {};
    const serviceBreakdown = {};

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      totalRevenue += amount;

      if (inv.invoice_type === 'Appointment') appointmentCount += 1;
      if (inv.invoice_type === 'Procedure') procedureCount += 1;
      if (inv.invoice_type === 'Pharmacy') pharmacyCount += 1;

      const dateKey = new Date(inv.createdAt).toISOString().split('T')[0];
      dailyRevenue[dateKey] = (dailyRevenue[dateKey] || 0) + amount;

      if (inv.patient_id) {
        const pId = String(inv.patient_id);
        if (!patientBreakdown[pId]) {
          patientBreakdown[pId] = {
            id: pId,
            name: inv.patient_info
              ? `${inv.patient_info.first_name} ${inv.patient_info.last_name || ''}`.trim()
              : 'Unknown',
            revenue: 0,
            visits: 0
          };
        }
        patientBreakdown[pId].revenue += amount;
        patientBreakdown[pId].visits += 1;
      }

      // Service breakdown by invoice type
      const serviceType = inv.invoice_type;
      serviceBreakdown[serviceType] = (serviceBreakdown[serviceType] || 0) + amount;

      // Detailed service items
      if (Array.isArray(inv.service_items) && inv.service_items.length) {
        inv.service_items.forEach((item) => {
          const itemName = item.name || 'Other Service';
          const key = `${serviceType} - ${itemName}`;
          serviceBreakdown[key] = (serviceBreakdown[key] || 0) + (item.total_price || 0);
        });
      }
    });

    const totalCommission = totalRevenue * (commissionPercentage / 100);
    const hospitalShare = totalRevenue - totalCommission;

    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([d, revenue]) => ({ date: d, revenue }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const patientBreakdownArray = Object.values(patientBreakdown).sort((a, b) => b.revenue - a.revenue);

    const serviceBreakdownArray = Object.entries(serviceBreakdown)
      .map(([service, revenue]) => ({
        service,
        revenue,
        commission: revenue * (commissionPercentage / 100),
        hospitalShare: revenue * (1 - (commissionPercentage / 100)),
        percentage: totalRevenue > 0 ? Number(((revenue / totalRevenue) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      doctor: {
        id: doctor._id,
        name: `${doctor.firstName} ${doctor.lastName || ''}`.trim(),
        department: doctor.department,
        specialization: doctor.specialization,
        licenseNumber: doctor.licenseNumber,
        revenuePercentage: commissionPercentage,
        isFullTime: doctor.isFullTime
      },
      period: { start, end },
      summary: {
        totalRevenue,
        totalCommission,
        hospitalShare,
        commissionPercentage,
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
        pharmacyCount,
        uniquePatients: Object.keys(patientBreakdown).length,
        averageRevenuePerPatient:
          Object.keys(patientBreakdown).length > 0
            ? Number((totalRevenue / Object.keys(patientBreakdown).length).toFixed(2))
            : 0,
        averageRevenuePerVisit: invoices.length > 0 ? Number((totalRevenue / invoices.length).toFixed(2)) : 0
      },
      breakdown: {
        daily: dailyBreakdown,
        byPatient: patientBreakdownArray,
        byService: serviceBreakdownArray
      },
      performance: {
        busiestDay: dailyBreakdown.reduce((max, day) => (day.revenue > max.revenue ? day : max), { revenue: 0 }),
        topPatient: patientBreakdownArray[0] || null,
        mostPerformedService: serviceBreakdownArray[0] || null
      }
    });
  } catch (error) {
    console.error('Error getting doctor revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Department revenue report
 */
exports.getDepartmentRevenue = async (req, res) => {
  try {
    const { department, startDate, endDate } = req.query;

    const deptObjId = toObjectId(department);
    if (!deptObjId) return res.status(400).json({ error: 'Invalid department' });

    const dateMatch = {};
    if (startDate && endDate) {
      dateMatch.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') };
    }

    // Get doctors in department
    const doctors = await Doctor.find({ department: deptObjId })
      .select('firstName lastName specialization department revenuePercentage isFullTime');
    const doctorIds = doctors.map((d) => d._id);

    // Invoices pipeline
    const pipeline = [
      { $match: { ...dateMatch } },
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      { $unwind: { path: '$appointment_info', preserveNullAndEmptyArrays: false } },
      { $match: { 'appointment_info.doctor_id': { $in: doctorIds } } },
      {
        $lookup: {
          from: 'doctors',
          localField: 'appointment_info.doctor_id',
          foreignField: '_id',
          as: 'doctor_info'
        }
      },
      { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } }
    ];

    const invoices = await Invoice.aggregate(pipeline);

    const dept = await Department.findById(deptObjId);
    if (!dept) return res.status(404).json({ error: 'Department not found' });

    let totalRevenue = 0;
    let appointmentCount = 0;
    let procedureCount = 0;
    let pharmacyCount = 0;

    const doctorBreakdown = {};
    const dailyRevenue = {};

    // Doctor commission calculation
    const doctorCommissionMap = new Map();
    doctors.forEach(doc => {
      doctorCommissionMap.set(doc._id.toString(), {
        revenuePercentage: doc.revenuePercentage || (doc.isFullTime ? 100 : 30),
        isFullTime: doc.isFullTime || false
      });
    });

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      totalRevenue += amount;

      if (inv.invoice_type === 'Appointment') appointmentCount += 1;
      if (inv.invoice_type === 'Procedure') procedureCount += 1;
      if (inv.invoice_type === 'Pharmacy') pharmacyCount += 1;

      const dateKey = new Date(inv.createdAt).toISOString().split('T')[0];
      dailyRevenue[dateKey] = (dailyRevenue[dateKey] || 0) + amount;

      const docId = inv.appointment_info?.doctor_id ? String(inv.appointment_info.doctor_id) : null;
      if (docId) {
        const d = inv.doctor_info;
        const name = d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown';
        const commissionInfo = doctorCommissionMap.get(docId);
        const commissionPercent = commissionInfo?.revenuePercentage || 30;
        const commission = amount * (commissionPercent / 100);

        if (!doctorBreakdown[docId]) {
          doctorBreakdown[docId] = {
            id: docId,
            name,
            revenue: 0,
            commission: 0,
            commissionPercentage: commissionPercent,
            invoices: 0,
            specialization: d?.specialization || 'N/A',
            isFullTime: commissionInfo?.isFullTime || false
          };
        }
        doctorBreakdown[docId].revenue += amount;
        doctorBreakdown[docId].commission += commission;
        doctorBreakdown[docId].invoices += 1;
      }
    });

    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([d, revenue]) => ({ date: d, revenue }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const doctorBreakdownArray = Object.values(doctorBreakdown).sort((a, b) => b.revenue - a.revenue);

    // Calculate department-wide commission
    const totalCommission = doctorBreakdownArray.reduce((sum, doc) => sum + doc.commission, 0);
    const hospitalShare = totalRevenue - totalCommission;
    const fullTimeCommission = doctorBreakdownArray
      .filter(doc => doc.isFullTime)
      .reduce((sum, doc) => sum + doc.commission, 0);
    const partTimeCommission = doctorBreakdownArray
      .filter(doc => !doc.isFullTime)
      .reduce((sum, doc) => sum + doc.commission, 0);

    res.json({
      department: {
        id: dept._id,
        name: dept.name,
        description: dept.description || ''
      },
      period: {
        start: dateMatch.createdAt?.$gte || null,
        end: dateMatch.createdAt?.$lte || null
      },
      summary: {
        totalRevenue,
        totalCommission,
        hospitalShare,
        fullTimeCommission,
        partTimeCommission,
        averageCommissionRate: totalRevenue > 0 ? (totalCommission / totalRevenue * 100) : 0,
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
        pharmacyCount,
        totalDoctors: doctorIds.length,
        activeDoctors: Object.keys(doctorBreakdown).length,
        averageRevenuePerDoctor:
          Object.keys(doctorBreakdown).length > 0
            ? Number((totalRevenue / Object.keys(doctorBreakdown).length).toFixed(2))
            : 0
      },
      breakdown: {
        daily: dailyBreakdown,
        byDoctor: doctorBreakdownArray
      },
      doctors: doctors.map((d) => ({
        id: d._id,
        name: `${d.firstName} ${d.lastName || ''}`.trim(),
        specialization: d.specialization,
        revenuePercentage: d.revenuePercentage || (d.isFullTime ? 100 : 30),
        isFullTime: d.isFullTime || false,
        revenue: doctorBreakdown[String(d._id)]?.revenue || 0,
        commission: doctorBreakdown[String(d._id)]?.commission || 0,
        invoices: doctorBreakdown[String(d._id)]?.invoices || 0
      }))
    });
  } catch (error) {
    console.error('Error getting department revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Detailed transactions report (paginated)
 */
exports.getDetailedRevenueReport = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      doctorId,
      departmentId,
      invoiceType,
      status,
      minAmount,
      maxAmount,
      page = 1,
      limit = 50
    } = req.query;

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    // Build pipeline with joins for doctor/department filters
    const baseQuery = {
      startDate,
      endDate,
      doctorId,
      departmentId,
      invoiceType,
      invoiceStatus: status,
      minAmount,
      maxAmount
    };

    const { pipeline, period } = buildInvoicePipeline(baseQuery, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure doctor_info present for projection (if not already)
    const hasDoctorInfoStage = pipeline.some((s) => s.$lookup && s.$lookup.from === 'doctors');
    if (!hasDoctorInfoStage) {
      pipeline.push(
        {
          $lookup: {
            from: 'doctors',
            localField: 'appointment_info.doctor_id',
            foreignField: '_id',
            as: 'doctor_info'
          }
        },
        { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } }
      );
    }

    // Total count with the same pipeline, but using $count
    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await Invoice.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

    // Data pipeline with pagination + projection
    const dataPipeline = [
      ...pipeline,
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) },
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
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ['$patient_info.first_name', ''] },
                    ' ',
                    { $ifNull: ['$patient_info.last_name', ''] }
                  ]
                }
              }
            },
            patientId: '$patient_info.patientId',
            type: '$patient_info.patient_type'
          },
          doctor: {
            name: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ['$doctor_info.firstName', ''] },
                    ' ',
                    { $ifNull: ['$doctor_info.lastName', ''] }
                  ]
                }
              }
            },
            department: '$doctor_info.department',
            revenuePercentage: '$doctor_info.revenuePercentage',
            isFullTime: '$doctor_info.isFullTime'
          },
          appointment_date: '$appointment_info.appointment_date',
          payment_method: { $arrayElemAt: ['$payment_history.method', -1] },
          service_items: 1,
          medicine_items: 1,
          procedure_items: 1,
          notes: 1
        }
      }
    ];

    const invoices = await Invoice.aggregate(dataPipeline);

    // Calculate commission for each invoice
    const invoicesWithCommission = invoices.map(inv => {
      const commissionPercent = inv.doctor?.revenuePercentage || (inv.doctor?.isFullTime ? 100 : 30);
      const commission = inv.total * (commissionPercent / 100);
      return {
        ...inv,
        commission,
        commission_percentage: commissionPercent,
        hospital_share: inv.total - commission
      };
    });

    const summary = {
      totalRevenue: invoicesWithCommission.reduce((sum, inv) => sum + (inv.total || 0), 0),
      totalPaid: invoicesWithCommission.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0),
      totalPending: invoicesWithCommission.reduce((sum, inv) => sum + (inv.balance_due || 0), 0),
      totalCommission: invoicesWithCommission.reduce((sum, inv) => sum + (inv.commission || 0), 0),
      totalHospitalShare: invoicesWithCommission.reduce((sum, inv) => sum + (inv.hospital_share || 0), 0),
      totalInvoices: invoicesWithCommission.length,
      appointmentCount: invoicesWithCommission.filter((inv) => inv.invoice_type === 'Appointment').length,
      pharmacyCount: invoicesWithCommission.filter((inv) => inv.invoice_type === 'Pharmacy').length,
      procedureCount: invoicesWithCommission.filter((inv) => inv.invoice_type === 'Procedure').length
    };

    res.json({
      period: { start: period.start || null, end: period.end || null },
      summary,
      transactions: invoicesWithCommission,
      pagination: {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
        total,
        totalPages: Math.ceil(total / parseInt(limit, 10))
      }
    });
  } catch (error) {
    console.error('Error getting detailed revenue report:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Helper function to format currency
 */
const formatCurrency = (amount) => {
  const num = Number(amount || 0);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(num);
};

/**
 * Export revenue data - Comprehensive with bifurcation
 */
exports.exportRevenueData = async (req, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      exportType = 'csv',
      includeBifurcation = true,
      includeCommissionSplit = true,
      doctorId,
      departmentId,
      invoiceType,
      status,
      minAmount,
      maxAmount
    } = req.query;

    // Build filter
    const filter = {};
    if (startDate && endDate) {
      filter.createdAt = { 
        $gte: new Date(startDate), 
        $lte: new Date(endDate + 'T23:59:59.999Z') 
      };
    }

    // Additional filters
    if (doctorId && doctorId !== 'all') {
      filter['appointment_id.doctor_id'] = toObjectId(doctorId);
    }
    if (invoiceType && invoiceType !== 'all') {
      filter.invoice_type = invoiceType;
    }
    if (status && status !== 'all') {
      filter.status = status;
    }
    if (minAmount || maxAmount) {
      filter.total = {};
      if (minAmount) filter.total.$gte = parseFloat(minAmount);
      if (maxAmount) filter.total.$lte = parseFloat(maxAmount);
    }

    // If department filter, get doctors first
    if (departmentId && departmentId !== 'all') {
      const doctorsInDept = await Doctor.find({ department: toObjectId(departmentId) }).select('_id');
      const doctorIds = doctorsInDept.map(d => d._id);
      filter['appointment_id.doctor_id'] = { $in: doctorIds };
    }

    // Fetch invoices with all necessary data
    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId patient_type')
      .populate({
        path: 'appointment_id',
        populate: { 
          path: 'doctor_id', 
          select: 'firstName lastName department revenuePercentage isFullTime specialization' 
        }
      })
      .sort({ createdAt: -1 })
      .limit(50000); // Increased limit for exports

    // Fetch doctors for revenue bifurcation
    const doctors = await Doctor.find({});
    const bifurcation = includeBifurcation ? calculateRevenueBifurcation(invoices, doctors) : null;

    // Prepare export data
    const exportData = invoices.map((invoice) => {
      const doctor = invoice.appointment_id?.doctor_id;
      const patient = invoice.patient_id;
      
      // Calculate commission for this invoice
      let commission = 0;
      let commissionPercentage = 30; // Default for part-time
      
      if (doctor) {
        commissionPercentage = doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30);
        commission = (invoice.total || 0) * (commissionPercentage / 100);
      }

      const hospitalShare = (invoice.total || 0) - commission;

      return {
        'Invoice Number': invoice.invoice_number,
        'Date': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[0] : '',
        'Time': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[1].split('.')[0] : '',
        'Type': invoice.invoice_type,
        'Patient Name': patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : 'Unknown',
        'Patient ID': patient?.patientId || 'N/A',
        'Patient Type': patient?.patient_type || 'N/A',
        'Doctor': doctor ? `${doctor.firstName} ${doctor.lastName || ''}`.trim() : 'N/A',
        'Doctor Type': doctor?.isFullTime ? 'Full-time' : 'Part-time',
        'Specialization': doctor?.specialization || 'N/A',
        'Department': doctor?.department || 'N/A',
        'Total Amount': invoice.total || 0,
        'Doctor Commission': includeCommissionSplit ? commission : 'N/A',
        'Commission %': includeCommissionSplit ? commissionPercentage : 'N/A',
        'Hospital Share': includeCommissionSplit ? hospitalShare : 'N/A',
        'Amount Paid': invoice.amount_paid || 0,
        'Balance Due': invoice.balance_due || 0,
        'Status': invoice.status,
        'Payment Method': Array.isArray(invoice.payment_history) && invoice.payment_history.length
            ? invoice.payment_history[invoice.payment_history.length - 1].method
            : 'N/A',
        'Services Count': invoice.service_items?.length || 0,
        'Medicines Count': invoice.medicine_items?.length || 0,
        'Procedures Count': invoice.procedure_items?.length || 0,
        'Total Services Value': invoice.service_items?.reduce((sum, item) => sum + (item.amount || 0), 0) || 0,
        'Total Medicines Value': invoice.medicine_items?.reduce((sum, item) => sum + (item.amount || 0), 0) || 0,
        'Total Procedures Value': invoice.procedure_items?.reduce((sum, item) => sum + (item.amount || 0), 0) || 0,
        'Notes': invoice.notes || ''
      };
    });

    // Add summary rows
    const totalInvoices = invoices.length;
    const totalRevenue = invoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0);
    const totalBalance = invoices.reduce((sum, inv) => sum + (inv.balance_due || 0), 0);

    const summaryRow = {
      'Invoice Number': '=== SUMMARY ===',
      'Date': '',
      'Time': '',
      'Type': '',
      'Patient Name': '',
      'Patient ID': '',
      'Patient Type': '',
      'Doctor': '',
      'Doctor Type': '',
      'Specialization': '',
      'Department': '',
      'Total Amount': totalRevenue,
      'Doctor Commission': bifurcation?.doctorCommission || 0,
      'Commission %': 'AVG',
      'Hospital Share': bifurcation?.hospitalRevenue || 0,
      'Amount Paid': totalPaid,
      'Balance Due': totalBalance,
      'Status': '',
      'Payment Method': '',
      'Services Count': invoices.reduce((sum, inv) => sum + (inv.service_items?.length || 0), 0),
      'Medicines Count': invoices.reduce((sum, inv) => sum + (inv.medicine_items?.length || 0), 0),
      'Procedures Count': invoices.reduce((sum, inv) => sum + (inv.procedure_items?.length || 0), 0),
      'Total Services Value': invoices.reduce((sum, inv) => sum + (inv.service_items?.reduce((s, item) => s + (item.amount || 0), 0) || 0), 0),
      'Total Medicines Value': invoices.reduce((sum, inv) => sum + (inv.medicine_items?.reduce((s, item) => s + (item.amount || 0), 0) || 0), 0),
      'Total Procedures Value': invoices.reduce((sum, inv) => sum + (inv.procedure_items?.reduce((s, item) => s + (item.amount || 0), 0) || 0), 0),
      'Notes': `Total Invoices: ${totalInvoices} | Period: ${startDate || 'Start'} to ${endDate || 'End'}`
    };

    const bifurcationRow = includeBifurcation ? {
      'Invoice Number': '=== REVENUE BIFURCATION ===',
      'Date': '',
      'Time': '',
      'Type': '',
      'Patient Name': '',
      'Patient ID': '',
      'Patient Type': '',
      'Doctor': '',
      'Doctor Type': '',
      'Specialization': '',
      'Department': '',
      'Total Amount': bifurcation.totalRevenue || 0,
      'Doctor Commission': bifurcation.doctorCommission || 0,
      'Commission %': totalRevenue > 0 ? `${((bifurcation.doctorCommission / totalRevenue) * 100).toFixed(1)}%` : '0%',
      'Hospital Share': bifurcation.hospitalRevenue || 0,
      'Amount Paid': '',
      'Balance Due': '',
      'Status': '',
      'Payment Method': '',
      'Services Count': '',
      'Medicines Count': '',
      'Procedures Count': '',
      'Total Services Value': '',
      'Total Medicines Value': '',
      'Total Procedures Value': '',
      'Notes': `Part-time Commission: ${formatCurrency(bifurcation.partTimeDoctorCommission || 0)} | Full-time Salaries: ${formatCurrency(bifurcation.fullTimeSalaryExpenses || 0)} | Net Hospital Revenue: ${formatCurrency(bifurcation.netHospitalRevenue || 0)} | Profit Margin: ${bifurcation.profitMargin?.toFixed(1) || 0}%`
    } : null;

    exportData.unshift(summaryRow);
    if (bifurcationRow) exportData.unshift(bifurcationRow);

    // Handle different export types
    if (exportType === 'json') {
      return res.json({
        period: {
          start: filter.createdAt?.$gte || null,
          end: filter.createdAt?.$lte || null
        },
        data: exportData,
        bifurcation: bifurcation,
        totals: {
          invoices: totalInvoices,
          revenue: totalRevenue,
          paid: totalPaid,
          balance: totalBalance
        }
      });
    } else if (exportType === 'excel') {
      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Revenue Data');
      
      // Add headers
      const headers = Object.keys(exportData[0]);
      worksheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: 20
      }));

      // Add data
      exportData.forEach(row => {
        worksheet.addRow(row);
      });

      // Style the summary rows
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber <= 3) { // First three rows are summary/bifurcation
          row.font = { bold: true };
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
          };
        }
      });

      // Set response headers
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=revenue_export_${startDate || 'all'}_to_${endDate || 'now'}.xlsx`);
      
      // Write to response
      await workbook.xlsx.write(res);
      res.end();
    } else if (exportType === 'pdf') {
      // Create PDF document
      const doc = new PDFDocument({ margin: 50 });
      
      // Set response headers
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=revenue_report_${startDate || 'all'}_to_${endDate || 'now'}.pdf`);
      
      // Pipe PDF to response
      doc.pipe(res);
      
      // Add content to PDF
      doc.fontSize(20).text('Revenue Report', { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Period: ${startDate || 'Start'} to ${endDate || 'End'}`, { align: 'center' });
      doc.moveDown();
      
      if (bifurcation) {
        doc.fontSize(14).text('Revenue Bifurcation:', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(12).text(`Total Revenue: ${formatCurrency(bifurcation.totalRevenue)}`);
        doc.text(`Doctor Commission: ${formatCurrency(bifurcation.doctorCommission)}`);
        doc.text(`Hospital Revenue: ${formatCurrency(bifurcation.hospitalRevenue)}`);
        doc.text(`Net Hospital Revenue: ${formatCurrency(bifurcation.netHospitalRevenue)}`);
        doc.text(`Profit Margin: ${bifurcation.profitMargin?.toFixed(1)}%`);
        doc.moveDown();
      }
      
      doc.fontSize(14).text('Summary:', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Total Invoices: ${totalInvoices}`);
      doc.text(`Total Amount: ${formatCurrency(totalRevenue)}`);
      doc.text(`Amount Paid: ${formatCurrency(totalPaid)}`);
      doc.text(`Balance Due: ${formatCurrency(totalBalance)}`);
      
      doc.end();
    } else {
      // Default: CSV download
      const headers = Object.keys(exportData[0]);
      const csvLines = [
        headers.join(','),
        ...exportData.map((row) =>
          headers
            .map((h) => {
              const v = row[h] ?? '';
              const s = String(v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(',')
        )
      ];

      const csvContent = csvLines.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=revenue_export_${Date.now()}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting revenue data:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Overview Data
 */
exports.exportOverview = async (req, res) => {
  try {
    const { exportType = 'csv', includeBifurcation = true } = req.query;
    
    // Use the same pipeline as calculateHospitalRevenue
    const { pipeline, period } = buildInvoicePipeline(req.query, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure doctor_info for bifurcation calculation
    const hasDoctorInfoStage = pipeline.some((s) => s.$lookup && s.$lookup.from === 'doctors');
    if (!hasDoctorInfoStage) {
      pipeline.push(
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
      );
    }

    const invoices = await Invoice.aggregate(pipeline);
    const doctors = await Doctor.find({});
    const bifurcation = includeBifurcation ? calculateRevenueBifurcation(invoices, doctors) : null;

    // Generate overview summary
    const overviewData = [
      {
        'Report Type': 'Revenue Overview',
        'Period': `${req.query.startDate || 'Start'} to ${req.query.endDate || 'End'}`,
        'Total Invoices': invoices.length,
        'Total Revenue': bifurcation?.totalRevenue || 0,
        'Doctor Commission': bifurcation?.doctorCommission || 0,
        'Hospital Revenue': bifurcation?.hospitalRevenue || 0,
        'Net Hospital Revenue': bifurcation?.netHospitalRevenue || 0,
        'Profit Margin': `${bifurcation?.profitMargin?.toFixed(1) || 0}%`,
        'Collection Rate': invoices.length > 0 
          ? `${((invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0) / bifurcation?.totalRevenue) * 100).toFixed(1)}%`
          : '0%'
      }
    ];

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Overview');
      
      worksheet.columns = [
        { header: 'Metric', key: 'metric', width: 25 },
        { header: 'Value', key: 'value', width: 25 }
      ];

      Object.entries(overviewData[0]).forEach(([key, value]) => {
        worksheet.addRow({ metric: key, value: value });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=revenue_overview_${Date.now()}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      return res.json({
        period: period,
        data: overviewData,
        bifurcation: bifurcation
      });
    }
  } catch (error) {
    console.error('Error exporting overview:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Daily Report
 */
exports.exportDaily = async (req, res) => {
  try {
    const { date, exportType = 'csv' } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required for daily export' });
    }

    const target = new Date(`${date}T00:00:00.000Z`);
    const startOfDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
    
    const baseQuery = {
      startDate: startOfDay.toISOString(),
      endDate: endOfDay.toISOString(),
      doctorId: req.query.doctorId,
      departmentId: req.query.departmentId,
      invoiceType: req.query.invoiceType,
      paymentMethod: req.query.paymentMethod
    };

    const { pipeline } = buildInvoicePipeline(baseQuery, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure doctor_info
    const hasDoctorInfoStage = pipeline.some((s) => s.$lookup && s.$lookup.from === 'doctors');
    if (!hasDoctorInfoStage) {
      pipeline.push(
        {
          $lookup: {
            from: 'doctors',
            localField: 'appointment_info.doctor_id',
            foreignField: '_id',
            as: 'doctor_info'
          }
        },
        { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } }
      );
    }

    const invoices = await Invoice.aggregate(pipeline);

    // Group by hour
    const hourlyData = {};
    invoices.forEach(invoice => {
      const hour = new Date(invoice.createdAt).getHours();
      const hourKey = `${hour}:00-${hour + 1}:00`;
      
      if (!hourlyData[hourKey]) {
        hourlyData[hourKey] = {
          hour: hourKey,
          revenue: 0,
          invoices: 0,
          commission: 0
        };
      }
      
      const doctor = invoice.doctor_info;
      const commissionPercent = doctor?.revenuePercentage || (doctor?.isFullTime ? 100 : 30);
      const commission = (invoice.total || 0) * (commissionPercent / 100);
      
      hourlyData[hourKey].revenue += invoice.total || 0;
      hourlyData[hourKey].commission += commission;
      hourlyData[hourKey].invoices += 1;
    });

    const dailyData = Object.values(hourlyData).sort((a, b) => {
      const hourA = parseInt(a.hour.split(':')[0]);
      const hourB = parseInt(b.hour.split(':')[0]);
      return hourA - hourB;
    });

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Daily Revenue');
      
      worksheet.columns = [
        { header: 'Hour', key: 'hour', width: 15 },
        { header: 'Revenue', key: 'revenue', width: 15 },
        { header: 'Doctor Commission', key: 'commission', width: 20 },
        { header: 'Hospital Share', key: 'hospitalShare', width: 15 },
        { header: 'Invoices', key: 'invoices', width: 10 }
      ];

      dailyData.forEach(row => {
        worksheet.addRow({
          ...row,
          hospitalShare: row.revenue - row.commission
        });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=daily_revenue_${date}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      const csvData = dailyData.map(row => ({
        Hour: row.hour,
        Revenue: row.revenue,
        'Doctor Commission': row.commission,
        'Hospital Share': row.revenue - row.commission,
        Invoices: row.invoices
      }));

      const headers = Object.keys(csvData[0]);
      const csvLines = [
        headers.join(','),
        ...csvData.map((row) =>
          headers
            .map((h) => {
              const v = row[h] ?? '';
              const s = String(v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(',')
        )
      ];

      const csvContent = csvLines.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=daily_revenue_${date}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting daily data:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Monthly Report
 */
exports.exportMonthly = async (req, res) => {
  try {
    const { year, month, exportType = 'csv' } = req.query;
    
    if (!year || !month) {
      return res.status(400).json({ error: 'Year and month are required for monthly export' });
    }

    const startOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const endOfMonth = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

    const baseQuery = {
      startDate: startOfMonth.toISOString(),
      endDate: endOfMonth.toISOString(),
      doctorId: req.query.doctorId,
      departmentId: req.query.departmentId,
      invoiceType: req.query.invoiceType,
      paymentMethod: req.query.paymentMethod,
      patientType: req.query.patientType
    };

    const { pipeline } = buildInvoicePipeline(baseQuery, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure doctor_info
    const hasDoctorInfoStage = pipeline.some((s) => s.$lookup && s.$lookup.from === 'doctors');
    if (!hasDoctorInfoStage) {
      pipeline.push(
        {
          $lookup: {
            from: 'doctors',
            localField: 'appointment_info.doctor_id',
            foreignField: '_id',
            as: 'doctor_info'
          }
        },
        { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } }
      );
    }

    pipeline.push({
      $addFields: {
        dayOfMonth: { $dayOfMonth: '$createdAt' }
      }
    });

    const invoices = await Invoice.aggregate(pipeline);

    // Group by week
    const weeklyData = {};
    invoices.forEach(invoice => {
      const weekNumber = Math.ceil((invoice.dayOfMonth + new Date(Date.UTC(year, month - 1, 1)).getUTCDay()) / 7);
      const weekKey = `Week ${weekNumber}`;
      
      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = {
          week: weekKey,
          revenue: 0,
          commission: 0,
          invoices: 0,
          startDay: ((weekNumber - 1) * 7) + 1,
          endDay: Math.min(weekNumber * 7, new Date(Date.UTC(year, month, 0)).getUTCDate())
        };
      }
      
      const doctor = invoice.doctor_info;
      const commissionPercent = doctor?.revenuePercentage || (doctor?.isFullTime ? 100 : 30);
      const commission = (invoice.total || 0) * (commissionPercent / 100);
      
      weeklyData[weekKey].revenue += invoice.total || 0;
      weeklyData[weekKey].commission += commission;
      weeklyData[weekKey].invoices += 1;
    });

    const monthlyData = Object.values(weeklyData).sort((a, b) => a.week.localeCompare(b.week));

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Monthly Revenue');
      
      worksheet.columns = [
        { header: 'Week', key: 'week', width: 10 },
        { header: 'Days', key: 'days', width: 15 },
        { header: 'Revenue', key: 'revenue', width: 15 },
        { header: 'Doctor Commission', key: 'commission', width: 20 },
        { header: 'Hospital Share', key: 'hospitalShare', width: 15 },
        { header: 'Invoices', key: 'invoices', width: 10 }
      ];

      monthlyData.forEach(row => {
        worksheet.addRow({
          week: row.week,
          days: `${row.startDay}-${row.endDay}`,
          revenue: row.revenue,
          commission: row.commission,
          hospitalShare: row.revenue - row.commission,
          invoices: row.invoices
        });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=monthly_revenue_${year}_${month}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      const csvData = monthlyData.map(row => ({
        Week: row.week,
        Days: `${row.startDay}-${row.endDay}`,
        Revenue: row.revenue,
        'Doctor Commission': row.commission,
        'Hospital Share': row.revenue - row.commission,
        Invoices: row.invoices
      }));

      const headers = Object.keys(csvData[0]);
      const csvLines = [
        headers.join(','),
        ...csvData.map((row) =>
          headers
            .map((h) => {
              const v = row[h] ?? '';
              const s = String(v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(',')
        )
      ];

      const csvContent = csvLines.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=monthly_revenue_${year}_${month}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting monthly data:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Doctor Report
 */
exports.exportDoctor = async (req, res) => {
  try {
    const { doctorId, startDate, endDate, exportType = 'csv' } = req.query;
    
    if (!doctorId) {
      return res.status(400).json({ error: 'Doctor ID is required' });
    }

    const doctorObjId = toObjectId(doctorId);
    if (!doctorObjId) return res.status(400).json({ error: 'Invalid doctorId' });

    // Default last 30 days if no dates
    let start = startDate ? new Date(startDate) : null;
    let end = endDate ? new Date(endDate + 'T23:59:59.999Z') : null;

    if (!start || !end) {
      const now = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(now.getDate() - 30);
      start = thirtyDaysAgo;
      end = now;
    }

    const pipeline = [];

    // invoice-only match first
    const match = { createdAt: { $gte: start, $lte: end } };
    if (req.query.invoiceType && req.query.invoiceType !== 'all') match.invoice_type = req.query.invoiceType;
    pipeline.push({ $match: match });

    // join appointment and match doctor
    pipeline.push(
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      { $unwind: { path: '$appointment_info', preserveNullAndEmptyArrays: true } },
      { $match: { 'appointment_info.doctor_id': doctorObjId } }
    );

    // patient lookup
    pipeline.push(
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient_info'
        }
      },
      { $unwind: { path: '$patient_info', preserveNullAndEmptyArrays: true } }
    );

    const invoices = await Invoice.aggregate(pipeline);

    const doctor = await Doctor.findById(doctorObjId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const commissionPercentage = doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30);
    
    // Group by service type
    const serviceData = {};
    invoices.forEach(invoice => {
      // Services
      invoice.service_items?.forEach(item => {
        const serviceName = item.name || 'Unknown Service';
        if (!serviceData[serviceName]) {
          serviceData[serviceName] = {
            service: serviceName,
            revenue: 0,
            count: 0
          };
        }
        serviceData[serviceName].revenue += item.amount || 0;
        serviceData[serviceName].count += 1;
      });

      // Medicines
      invoice.medicine_items?.forEach(item => {
        const medName = item.medicine_name || 'Unknown Medicine';
        if (!serviceData[medName]) {
          serviceData[medName] = {
            service: medName,
            revenue: 0,
            count: 0
          };
        }
        serviceData[medName].revenue += item.amount || 0;
        serviceData[medName].count += 1;
      });

      // Procedures
      invoice.procedure_items?.forEach(item => {
        const procName = item.name || 'Unknown Procedure';
        if (!serviceData[procName]) {
          serviceData[procName] = {
            service: procName,
            revenue: 0,
            count: 0
          };
        }
        serviceData[procName].revenue += item.amount || 0;
        serviceData[procName].count += 1;
      });
    });

    const serviceBreakdown = Object.values(serviceData);
    const totalRevenue = invoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
    const totalCommission = totalRevenue * (commissionPercentage / 100);

    const doctorData = {
      'Doctor Name': `${doctor.firstName} ${doctor.lastName}`,
      'Employee Type': doctor.isFullTime ? 'Full-time' : 'Part-time',
      'Commission Rate': `${commissionPercentage}%`,
      'Period': `${startDate || 'Start'} to ${endDate || 'End'}`,
      'Total Invoices': invoices.length,
      'Total Revenue': totalRevenue,
      'Total Commission': totalCommission,
      'Hospital Share': totalRevenue - totalCommission,
      'Unique Patients': new Set(invoices.map(inv => inv.patient_id?.toString())).size
    };

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      
      // Summary sheet
      const summarySheet = workbook.addWorksheet('Doctor Summary');
      summarySheet.columns = [
        { header: 'Metric', key: 'metric', width: 25 },
        { header: 'Value', key: 'value', width: 25 }
      ];

      Object.entries(doctorData).forEach(([key, value]) => {
        summarySheet.addRow({ metric: key, value: value });
      });

      // Services sheet
      if (serviceBreakdown.length > 0) {
        const servicesSheet = workbook.addWorksheet('Services Breakdown');
        servicesSheet.columns = [
          { header: 'Service', key: 'service', width: 30 },
          { header: 'Revenue', key: 'revenue', width: 15 },
          { header: 'Count', key: 'count', width: 10 },
          { header: 'Commission', key: 'commission', width: 15 },
          { header: 'Hospital Share', key: 'hospitalShare', width: 15 }
        ];

        serviceBreakdown.forEach(row => {
          const commission = row.revenue * (commissionPercentage / 100);
          servicesSheet.addRow({
            service: row.service,
            revenue: row.revenue,
            count: row.count,
            commission: commission,
            hospitalShare: row.revenue - commission
          });
        });
      }

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=doctor_${doctor.firstName}_${doctor.lastName}_${Date.now()}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      const csvData = [
        doctorData,
        ...serviceBreakdown.map(row => ({
          Service: row.service,
          Revenue: row.revenue,
          Count: row.count,
          Commission: row.revenue * (commissionPercentage / 100),
          'Hospital Share': row.revenue * (1 - (commissionPercentage / 100))
        }))
      ];

      const headers = Object.keys(csvData[0]);
      const csvLines = [
        headers.join(','),
        ...csvData.map((row) =>
          headers
            .map((h) => {
              const v = row[h] ?? '';
              const s = String(v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(',')
        )
      ];

      const csvContent = csvLines.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=doctor_${doctor.firstName}_${doctor.lastName}_${Date.now()}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting doctor data:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Department Report
 */
exports.exportDepartment = async (req, res) => {
  try {
    const { department, startDate, endDate, exportType = 'csv' } = req.query;
    
    if (!department) {
      return res.status(400).json({ error: 'Department ID is required' });
    }

    const deptObjId = toObjectId(department);
    if (!deptObjId) return res.status(400).json({ error: 'Invalid department' });

    const dateMatch = {};
    if (startDate && endDate) {
      dateMatch.createdAt = { 
        $gte: new Date(startDate), 
        $lte: new Date(endDate + 'T23:59:59.999Z') 
      };
    }

    // Get doctors in department
    const doctors = await Doctor.find({ department: deptObjId })
      .select('firstName lastName department revenuePercentage isFullTime specialization');
    const doctorIds = doctors.map((d) => d._id);

    // Invoices pipeline
    const pipeline = [
      { $match: { ...dateMatch } },
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment_info'
        }
      },
      { $unwind: { path: '$appointment_info', preserveNullAndEmptyArrays: false } },
      { $match: { 'appointment_info.doctor_id': { $in: doctorIds } } },
      {
        $lookup: {
          from: 'doctors',
          localField: 'appointment_info.doctor_id',
          foreignField: '_id',
          as: 'doctor_info'
        }
      },
      { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } }
    ];

    const invoices = await Invoice.aggregate(pipeline);

    const dept = await Department.findById(deptObjId);
    if (!dept) return res.status(404).json({ error: 'Department not found' });
    
    // Group by doctor
    const doctorPerformance = {};
    invoices.forEach(invoice => {
      const doctor = invoice.doctor_info;
      if (!doctor) return;

      const doctorId = doctor._id.toString();
      const commissionPercent = doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30);
      
      if (!doctorPerformance[doctorId]) {
        doctorPerformance[doctorId] = {
          doctorId,
          name: `${doctor.firstName} ${doctor.lastName}`,
          revenue: 0,
          commission: 0,
          invoices: 0,
          commissionPercent,
          isFullTime: doctor.isFullTime || false,
          specialization: doctor.specialization || 'N/A'
        };
      }

      const commission = (invoice.total || 0) * (commissionPercent / 100);
      doctorPerformance[doctorId].revenue += invoice.total || 0;
      doctorPerformance[doctorId].commission += commission;
      doctorPerformance[doctorId].invoices += 1;
    });

    const performanceData = Object.values(doctorPerformance);
    const totalRevenue = performanceData.reduce((sum, doc) => sum + doc.revenue, 0);
    const totalCommission = performanceData.reduce((sum, doc) => sum + doc.commission, 0);

    const departmentData = {
      'Department': dept.name || 'Unknown',
      'Period': `${startDate || 'Start'} to ${endDate || 'End'}`,
      'Total Doctors': doctors.length,
      'Active Doctors': performanceData.length,
      'Total Invoices': invoices.length,
      'Total Revenue': totalRevenue,
      'Total Doctor Commission': totalCommission,
      'Hospital Share': totalRevenue - totalCommission,
      'Average Commission Rate': `${(totalCommission / totalRevenue * 100).toFixed(1)}%`,
      'Full-time Commission': performanceData.filter(d => d.isFullTime).reduce((sum, doc) => sum + doc.commission, 0),
      'Part-time Commission': performanceData.filter(d => !d.isFullTime).reduce((sum, doc) => sum + doc.commission, 0)
    };

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      
      // Summary sheet
      const summarySheet = workbook.addWorksheet('Department Summary');
      summarySheet.columns = [
        { header: 'Metric', key: 'metric', width: 30 },
        { header: 'Value', key: 'value', width: 30 }
      ];

      Object.entries(departmentData).forEach(([key, value]) => {
        summarySheet.addRow({ metric: key, value: value });
      });

      // Doctors sheet
      if (performanceData.length > 0) {
        const doctorsSheet = workbook.addWorksheet('Doctors Performance');
        doctorsSheet.columns = [
          { header: 'Doctor', key: 'name', width: 25 },
          { header: 'Specialization', key: 'specialization', width: 20 },
          { header: 'Type', key: 'type', width: 15 },
          { header: 'Revenue', key: 'revenue', width: 15 },
          { header: 'Commission', key: 'commission', width: 15 },
          { header: 'Commission %', key: 'commissionPercent', width: 15 },
          { header: 'Hospital Share', key: 'hospitalShare', width: 15 },
          { header: 'Invoices', key: 'invoices', width: 10 }
        ];

        performanceData.forEach(doc => {
          doctorsSheet.addRow({
            name: doc.name,
            specialization: doc.specialization,
            type: doc.isFullTime ? 'Full-time' : 'Part-time',
            revenue: doc.revenue,
            commission: doc.commission,
            commissionPercent: doc.commissionPercent,
            hospitalShare: doc.revenue - doc.commission,
            invoices: doc.invoices
          });
        });
      }

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=department_${dept.name.replace(/\s+/g, '_')}_${Date.now()}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      const csvData = [
        departmentData,
        ...performanceData.map(doc => ({
          Doctor: doc.name,
          Specialization: doc.specialization,
          Type: doc.isFullTime ? 'Full-time' : 'Part-time',
          Revenue: doc.revenue,
          Commission: doc.commission,
          'Commission %': doc.commissionPercent,
          'Hospital Share': doc.revenue - doc.commission,
          Invoices: doc.invoices
        }))
      ];

      const headers = Object.keys(csvData[0]);
      const csvLines = [
        headers.join(','),
        ...csvData.map((row) =>
          headers
            .map((h) => {
              const v = row[h] ?? '';
              const s = String(v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(',')
        )
      ];

      const csvContent = csvLines.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=department_${dept.name.replace(/\s+/g, '_')}_${Date.now()}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting department data:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Detailed Report
 */
/**
 * Export Detailed Report
 */
exports.exportDetailed = async (req, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      exportType = 'csv',
      doctorId,
      departmentId,
      invoiceType,
      status,
      minAmount,
      maxAmount,
      includeCommissionSplit = true
    } = req.query;

    // Build filter
    const filter = {};
    if (startDate && endDate) {
      filter.createdAt = { 
        $gte: new Date(startDate), 
        $lte: new Date(endDate + 'T23:59:59.999Z') 
      };
    }

    // Additional filters
    if (doctorId && doctorId !== 'all') {
      filter['appointment_id.doctor_id'] = toObjectId(doctorId);
    }
    if (invoiceType && invoiceType !== 'all') {
      filter.invoice_type = invoiceType;
    }
    if (status && status !== 'all') {
      filter.status = status;
    }
    if (minAmount || maxAmount) {
      filter.total = {};
      if (minAmount) filter.total.$gte = parseFloat(minAmount);
      if (maxAmount) filter.total.$lte = parseFloat(maxAmount);
    }

    // If department filter, get doctors first
    if (departmentId && departmentId !== 'all') {
      const doctorsInDept = await Doctor.find({ department: toObjectId(departmentId) }).select('_id');
      const doctorIds = doctorsInDept.map(d => d._id);
      filter['appointment_id.doctor_id'] = { $in: doctorIds };
    }

    // Fetch invoices with all necessary data
    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId patient_type')
      .populate({
        path: 'appointment_id',
        populate: { 
          path: 'doctor_id', 
          select: 'firstName lastName department revenuePercentage isFullTime specialization' 
        }
      })
      .sort({ createdAt: -1 })
      .limit(50000);

    // Prepare export data
    const exportData = invoices.map((invoice) => {
      const doctor = invoice.appointment_id?.doctor_id;
      const patient = invoice.patient_id;
      
      // Calculate commission for this invoice
      let commission = 0;
      let commissionPercentage = 30; // Default for part-time
      
      if (doctor) {
        commissionPercentage = doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30);
        commission = (invoice.total || 0) * (commissionPercentage / 100);
      }

      const hospitalShare = (invoice.total || 0) - commission;

      return {
        'Invoice Number': invoice.invoice_number,
        'Date': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[0] : '',
        'Time': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[1].split('.')[0] : '',
        'Type': invoice.invoice_type,
        'Patient Name': patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : 'Unknown',
        'Patient ID': patient?.patientId || 'N/A',
        'Patient Type': patient?.patient_type || 'N/A',
        'Doctor': doctor ? `${doctor.firstName} ${doctor.lastName || ''}`.trim() : 'N/A',
        'Doctor Type': doctor?.isFullTime ? 'Full-time' : 'Part-time',
        'Specialization': doctor?.specialization || 'N/A',
        'Department': doctor?.department || 'N/A',
        'Total Amount': invoice.total || 0,
        'Doctor Commission': includeCommissionSplit ? commission : 'N/A',
        'Commission %': includeCommissionSplit ? commissionPercentage : 'N/A',
        'Hospital Share': includeCommissionSplit ? hospitalShare : 'N/A',
        'Amount Paid': invoice.amount_paid || 0,
        'Balance Due': invoice.balance_due || 0,
        'Status': invoice.status,
        'Payment Method': Array.isArray(invoice.payment_history) && invoice.payment_history.length
            ? invoice.payment_history[invoice.payment_history.length - 1].method
            : 'N/A',
        'Services Count': invoice.service_items?.length || 0,
        'Medicines Count': invoice.medicine_items?.length || 0,
        'Procedures Count': invoice.procedure_items?.length || 0,
        'Total Services Value': invoice.service_items?.reduce((sum, item) => sum + (item.amount || 0), 0) || 0,
        'Total Medicines Value': invoice.medicine_items?.reduce((sum, item) => sum + (item.amount || 0), 0) || 0,
        'Total Procedures Value': invoice.procedure_items?.reduce((sum, item) => sum + (item.amount || 0), 0) || 0,
        'Notes': invoice.notes || ''
      };
    });

    // Check if we have data
    if (exportData.length === 0) {
      if (exportType === 'json') {
        return res.json({
          message: 'No data found for the selected filters',
          period: {
            start: startDate,
            end: endDate
          },
          data: [],
          totals: {
            invoices: 0,
            revenue: 0,
            paid: 0,
            balance: 0
          }
        });
      } else {
        // Create empty data with headers
        const emptyRow = {
          'Invoice Number': 'No data found',
          'Date': '',
          'Time': '',
          'Type': '',
          'Patient Name': '',
          'Patient ID': '',
          'Patient Type': '',
          'Doctor': '',
          'Doctor Type': '',
          'Specialization': '',
          'Department': '',
          'Total Amount': 0,
          'Doctor Commission': 0,
          'Commission %': 0,
          'Hospital Share': 0,
          'Amount Paid': 0,
          'Balance Due': 0,
          'Status': '',
          'Payment Method': '',
          'Services Count': 0,
          'Medicines Count': 0,
          'Procedures Count': 0,
          'Total Services Value': 0,
          'Total Medicines Value': 0,
          'Total Procedures Value': 0,
          'Notes': `No invoices found for period: ${startDate || 'Start'} to ${endDate || 'End'}`
        };
        
        exportData.push(emptyRow);
      }
    }

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Detailed Revenue');
      
      // Add headers
      const headers = Object.keys(exportData[0]);
      worksheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: 20
      }));

      // Add data
      exportData.forEach(row => {
        worksheet.addRow(row);
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=detailed_revenue_${startDate || 'all'}_to_${endDate || 'now'}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else if (exportType === 'json') {
      return res.json({
        period: {
          start: startDate,
          end: endDate
        },
        data: exportData,
        totals: {
          invoices: invoices.length,
          revenue: invoices.reduce((sum, inv) => sum + (inv.total || 0), 0),
          paid: invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0),
          balance: invoices.reduce((sum, inv) => sum + (inv.balance_due || 0), 0)
        }
      });
    } else {
      const headers = Object.keys(exportData[0]);
      const csvLines = [
        headers.join(','),
        ...exportData.map((row) =>
          headers
            .map((h) => {
              const v = row[h] ?? '';
              const s = String(v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s;
            })
            .join(',')
        )
      ];

      const csvContent = csvLines.join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=detailed_revenue_${startDate || 'all'}_to_${endDate || 'now'}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting detailed data:', error);
    res.status(500).json({ error: error.message });
  }
};