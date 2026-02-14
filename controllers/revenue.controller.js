// controllers/revenue.controller.js - COMPLETE UPDATED VERSION
// All date queries now support both created_at and createdAt fields

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
 * Helper function to get date field with fallback
 */
const getDateField = (doc) => {
  return doc.created_at || doc.createdAt;
};

/**
 * Build date filter that works with both created_at and createdAt
 */
const buildDateFilter = (startDate, endDate) => {
  if (startDate && endDate) {
    return {
      $or: [
        { 
          created_at: { 
            $gte: new Date(startDate), 
            $lte: new Date(endDate + 'T23:59:59.999Z') 
          } 
        },
        { 
          createdAt: { 
            $gte: new Date(startDate), 
            $lte: new Date(endDate + 'T23:59:59.999Z') 
          } 
        }
      ]
    };
  } else {
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - 30);
    return {
      $or: [
        { created_at: { $gte: thirtyDaysAgo, $lte: now } },
        { createdAt: { $gte: thirtyDaysAgo, $lte: now } }
      ]
    };
  }
};

/**
 * Build invoice aggregation pipeline with correct joins + filters
 * Supports both created_at and createdAt date fields
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
  const dateMatch = buildDateFilter(startDate, endDate);

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

  // Add a computed date field for later use
  pipeline.push({
    $addFields: {
      computed_date: {
        $ifNull: ['$created_at', '$createdAt']
      }
    }
  });

  return {
    pipeline,
    // expose computed period start/end for response
    period: {
      start: startDate ? new Date(startDate) : (() => {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        return d;
      })(),
      end: endDate ? new Date(endDate + 'T23:59:59.999Z') : new Date()
    }
  };
}

/**
 * Enhanced revenue calculation with detailed bifurcation
 */
const calculateRevenueBifurcation = (invoices, doctors) => {
  let totalRevenue = 0;
  let doctorRevenue = 0;
  let hospitalRevenue = 0;
  let doctorCommission = 0;
  let fullTimeSalaryExpenses = 0;
  let partTimeDoctorCommission = 0;

  // Track procedure-specific metrics
  let procedureRevenue = 0;
  let procedureDoctorCommission = 0;
  let procedureHospitalRevenue = 0;

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

    // Track procedure-specific revenue
    if (invoice.invoice_type === 'Procedure') {
      procedureRevenue += invoiceAmount;
    }

    if (invoice.appointment_id?.doctor_id) {
      const doctorId = invoice.appointment_id.doctor_id.toString();
      const doctorInfo = doctorMap.get(doctorId);
      
      if (doctorInfo) {
        const doctorShare = invoiceAmount * (doctorInfo.revenuePercentage / 100);
        const hospitalShare = invoiceAmount - doctorShare;
        
        doctorRevenue += doctorShare;
        hospitalRevenue += hospitalShare;
        
        // Track procedure-specific commission
        if (invoice.invoice_type === 'Procedure') {
          procedureDoctorCommission += doctorShare;
          procedureHospitalRevenue += hospitalShare;
        }
        
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
        
        if (invoice.invoice_type === 'Procedure') {
          procedureHospitalRevenue += invoiceAmount * 0.7;
          procedureDoctorCommission += invoiceAmount * 0.3;
        }
      }
    } else {
      // No doctor associated - all to hospital
      hospitalRevenue += invoiceAmount;
      if (invoice.invoice_type === 'Procedure') {
        procedureHospitalRevenue += invoiceAmount;
      }
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
    profitMargin: totalRevenue > 0 ? ((hospitalRevenue - fullTimeSalaryExpenses) / totalRevenue) * 100 : 0,
    // Add procedure-specific metrics
    procedureMetrics: {
      revenue: procedureRevenue,
      doctorCommission: procedureDoctorCommission,
      hospitalRevenue: procedureHospitalRevenue,
      percentage: totalRevenue > 0 ? (procedureRevenue / totalRevenue) * 100 : 0
    }
  };
};

/**
 * Calculate hospital revenue with dual date field support
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
    const procedureRevenueByDoctor = {}; // Track procedure revenue per doctor
    const procedureRevenueByDepartment = {}; // Track procedure revenue per department

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

        // Track procedure revenue by doctor
        if (inv.invoice_type === 'Procedure') {
          procedureRevenueByDoctor[dId] = (procedureRevenueByDoctor[dId] || 0) + amount;
        }

        const deptId = inv.department_id ? String(inv.department_id) : 'Unknown';
        departmentRevenue[deptId] = (departmentRevenue[deptId] || 0) + amount;
        
        // Track procedure revenue by department
        if (inv.invoice_type === 'Procedure') {
          procedureRevenueByDepartment[deptId] = (procedureRevenueByDepartment[deptId] || 0) + amount;
        }
      } else {
        departmentRevenue['Unknown'] = (departmentRevenue['Unknown'] || 0) + amount;
      }

      // Patient revenue
      if (inv.patient_id) {
        const pId = String(inv.patient_id);
        uniquePatients.add(pId);
        patientRevenue[pId] = (patientRevenue[pId] || 0) + amount;
      }

      // Use computed_date or fallback to either field
      const dateValue = inv.computed_date || inv.created_at || inv.createdAt;
      const dateKey = new Date(dateValue).toISOString().split('T')[0];
      
      if (!dailyStats[dateKey]) {
        dailyStats[dateKey] = {
          date: dateKey,
          revenue: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0,
          procedureRevenue: 0,
          appointmentRevenue: 0,
          pharmacyRevenue: 0,
          purchaseRevenue: 0
        };
      }
      dailyStats[dateKey].revenue += amount;
      
      // Track by type
      if (inv.invoice_type === 'Appointment') {
        dailyStats[dateKey].appointments += 1;
        dailyStats[dateKey].appointmentRevenue += amount;
      } else if (inv.invoice_type === 'Pharmacy') {
        dailyStats[dateKey].pharmacy += 1;
        dailyStats[dateKey].pharmacyRevenue += amount;
      } else if (inv.invoice_type === 'Procedure') {
        dailyStats[dateKey].procedures += 1;
        dailyStats[dateKey].procedureRevenue += amount;
      } else {
        dailyStats[dateKey].purchaseRevenue = (dailyStats[dateKey].purchaseRevenue || 0) + amount;
      }

      // Payment methods
      if (Array.isArray(inv.payment_history) && inv.payment_history.length) {
        inv.payment_history.forEach((p) => {
          const method = p.method || 'Unknown';
          paymentMethods[method] = (paymentMethods[method] || 0) + (p.amount || 0);
        });
      }
    });

    // Get detailed procedure items breakdown - handle both date fields
    const procedureMatch = { invoice_type: 'Procedure' };
    if (period.start && period.end) {
      procedureMatch.$or = [
        { created_at: { $gte: period.start, $lte: period.end } },
        { createdAt: { $gte: period.start, $lte: period.end } }
      ];
    }

    const procedureDetails = await Invoice.aggregate([
      { $match: procedureMatch },
      { $unwind: '$procedure_items' },
      {
        $group: {
          _id: '$procedure_items.procedure_code',
          procedureCode: { $first: '$procedure_items.procedure_code' },
          procedureName: { $first: '$procedure_items.procedure_name' },
          totalRevenue: { $sum: '$procedure_items.total_price' },
          count: { $sum: '$procedure_items.quantity' },
          averagePrice: { $avg: '$procedure_items.unit_price' }
        }
      },
      { $sort: { totalRevenue: -1 } }
    ]);

    // Salary expenses
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

    // Top doctors
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
      const procedureRev = procedureRevenueByDoctor[String(id)] || 0;
      const commissionPercentage = d?.revenuePercentage || (d?.isFullTime ? 100 : 30);
      const commission = revenue * (commissionPercentage / 100);
      
      return {
        doctorId: String(id),
        name: d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown',
        revenue,
        procedureRevenue: procedureRev,
        commission,
        commissionPercentage,
        department: d?.department || 'Unknown',
        specialization: d?.specialization || 'N/A'
      };
    });

    // Top patients
    const topPatientIds = Object.entries(patientRevenue)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([id]) => toObjectId(id))
      .filter(Boolean);

    const patientDocs = topPatientIds.length
      ? await Patient.find({ _id: { $in: topPatientIds } }).select('first_name last_name patient_type')
      : [];
    const patientMap = new Map(patientDocs.map((p) => [String(p._id), p]));

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

    const paymentMethodBreakdown = Object.entries(paymentMethods)
      .map(([method, amount]) => ({
        method,
        amount,
        percentage: paidAmount > 0 ? Number(((amount / paidAmount) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.amount - a.amount);

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

    // Get department names for procedure breakdown
    const departments = await Department.find({});
    const deptMap = new Map(departments.map(d => [d._id.toString(), d.name]));

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
        doctorRevenue: bifurcation.doctorRevenue,
        hospitalRevenue: bifurcation.hospitalRevenue,
        doctorCommission: bifurcation.doctorCommission,
        netHospitalRevenue: bifurcation.netHospitalRevenue,
        collectionRate: totalRevenue > 0 ? (paidAmount / totalRevenue) * 100 : 0,
        pendingRate: totalRevenue > 0 ? (pendingAmount / totalRevenue) * 100 : 0,
        // Add procedure metrics
        procedureMetrics: bifurcation.procedureMetrics
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
            average: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0,
            // Add procedure-specific breakdown
            byProcedure: procedureDetails.map(p => ({
              code: p.procedureCode,
              name: p.procedureName,
              revenue: p.totalRevenue,
              count: p.count,
              averagePrice: p.averagePrice,
              percentage: procedureRevenue > 0 ? (p.totalRevenue / procedureRevenue) * 100 : 0
            })),
            byDoctor: Object.entries(procedureRevenueByDoctor).map(([docId, rev]) => ({
              doctorId: docId,
              doctorName: doctorMap.get(docId)?.name || 'Unknown',
              revenue: rev,
              percentage: procedureRevenue > 0 ? (rev / procedureRevenue) * 100 : 0
            })).sort((a, b) => b.revenue - a.revenue),
            byDepartment: Object.entries(procedureRevenueByDepartment).map(([deptId, rev]) => ({
              departmentId: deptId,
              departmentName: deptMap.get(deptId) || deptId === 'Unknown' ? 'Unknown' : 'Unknown Department',
              revenue: rev,
              percentage: procedureRevenue > 0 ? (rev / procedureRevenue) * 100 : 0
            })).sort((a, b) => b.revenue - a.revenue)
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
            departmentName: deptMap.get(departmentId) || departmentId === 'Unknown' ? 'Unknown' : 'Unknown Department',
            amount,
            percentage: totalRevenue > 0 ? Number(((amount / totalRevenue) * 100).toFixed(2)) : 0
          }))
          .sort((a, b) => b.amount - a.amount),
        byPaymentMethod: paymentMethodBreakdown,
        daily: dailyBreakdown
      },
      topPerformers: {
        doctors: topDoctors,
        patients: topPatients,
        procedures: procedureDetails.slice(0, 5).map(p => ({
          code: p.procedureCode,
          name: p.procedureName,
          revenue: p.totalRevenue,
          count: p.count,
          averagePrice: p.averagePrice
        }))
      },
      metrics: {
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0,
        expenseRatio: totalRevenue > 0 ? Number(((totalSalaryExpenses / totalRevenue) * 100).toFixed(2)) : 0,
        averageInvoiceValue: totalInvoices > 0 ? Number((totalRevenue / totalInvoices).toFixed(2)) : 0,
        averageDailyRevenue: dailyBreakdown.length > 0 ? Number((totalRevenue / dailyBreakdown.length).toFixed(2)) : 0,
        averageProcedureValue: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0,
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
 * Get procedure revenue analytics with dual date field support
 */
exports.getProcedureRevenueAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, departmentId, doctorId } = req.query;

    console.log('📊 Procedure Revenue Request:', { startDate, endDate, departmentId, doctorId });

    // Use the same date handling with dual field support
    let startOfDayUTC, endOfDayUTC;
    
    if (startDate && endDate) {
      // If both dates provided, use the range
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      
      endOfDayUTC = new Date(endDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else if (startDate) {
      // If only start date provided, use that day
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(startDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else {
      // Default to last 30 days
      endOfDayUTC = new Date();
      startOfDayUTC = new Date();
      startOfDayUTC.setDate(startOfDayUTC.getDate() - 30);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC.setHours(23, 59, 59, 999);
    }

    console.log('📅 Date range:', {
      start: startOfDayUTC.toISOString(),
      end: endOfDayUTC.toISOString()
    });

    // Build the date filter using dual field support
    const dateFilter = {
      $or: [
        {
          created_at: {
            $gte: startOfDayUTC,
            $lte: endOfDayUTC
          }
        },
        {
          createdAt: {
            $gte: startOfDayUTC,
            $lte: endOfDayUTC
          }
        }
      ]
    };

    // Build pipeline for procedure revenue
    const pipeline = [
      // Match only Procedure invoices
      { 
        $match: { 
          invoice_type: 'Procedure',
          ...dateFilter
        } 
      },
      
      // Unwind procedure_items to get individual procedure records
      { $unwind: { path: '$procedure_items', preserveNullAndEmptyArrays: false } },
      
      // Lookup appointment to get doctor
      {
        $lookup: {
          from: 'appointments',
          localField: 'appointment_id',
          foreignField: '_id',
          as: 'appointment'
        }
      },
      { $unwind: { path: '$appointment', preserveNullAndEmptyArrays: true } },
      
      // Lookup doctor
      {
        $lookup: {
          from: 'doctors',
          localField: 'appointment.doctor_id',
          foreignField: '_id',
          as: 'doctor'
        }
      },
      { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
      
      // Lookup patient
      {
        $lookup: {
          from: 'patients',
          localField: 'patient_id',
          foreignField: '_id',
          as: 'patient'
        }
      },
      { $unwind: { path: '$patient', preserveNullAndEmptyArrays: true } },
      
      // Add computed fields
      {
        $addFields: {
          procedureCode: '$procedure_items.procedure_code',
          procedureName: '$procedure_items.procedure_name',
          procedureRevenue: '$procedure_items.total_price',
          procedureQuantity: '$procedure_items.quantity',
          doctorId: { $ifNull: ['$doctor._id', null] },
          doctorName: { 
            $cond: {
              if: { $and: ['$doctor.firstName', '$doctor.lastName'] },
              then: { $concat: ['$doctor.firstName', ' ', '$doctor.lastName'] },
              else: 'Unknown'
            }
          },
          departmentId: '$doctor.department',
          date: { 
            $dateToString: { 
              format: '%Y-%m-%d', 
              date: { $ifNull: ['$created_at', '$createdAt'] }
            } 
          }
        }
      }
    ];

    // Apply doctor filter if provided
    if (doctorId && doctorId !== 'all' && doctorId !== 'undefined') {
      pipeline.push({ 
        $match: { 
          'appointment.doctor_id': new mongoose.Types.ObjectId(doctorId) 
        } 
      });
    }

    // Apply department filter if provided
    if (departmentId && departmentId !== 'all' && departmentId !== 'undefined') {
      pipeline.push({ 
        $match: { 
          'doctor.department': new mongoose.Types.ObjectId(departmentId) 
        } 
      });
    }

    const procedureInvoices = await Invoice.aggregate(pipeline);
    
    console.log('✅ Procedure invoice items after pipeline:', procedureInvoices.length);

    // Group by procedure code
    const procedureStats = {};
    const doctorProcedureStats = {};
    const dailyProcedureStats = {};
    const departmentProcedureStats = {};

    let totalProcedureRevenue = 0;
    let totalProcedureCount = 0;

    procedureInvoices.forEach(item => {
      const procCode = item.procedureCode || 'UNKNOWN';
      const procName = item.procedureName || 'Unknown Procedure';
      const revenue = item.procedureRevenue || 0;
      const quantity = item.procedureQuantity || 1;
      const doctorId = item.doctorId ? item.doctorId.toString() : 'unknown';
      const doctorName = item.doctorName || 'Unknown';
      const departmentId = item.departmentId ? item.departmentId.toString() : 'unknown';
      const dateKey = item.date || new Date().toISOString().split('T')[0];

      totalProcedureRevenue += revenue;
      totalProcedureCount += 1;

      // Procedure stats
      if (!procedureStats[procCode]) {
        procedureStats[procCode] = {
          code: procCode,
          name: procName,
          revenue: 0,
          quantity: 0,
          count: 0,
          averagePrice: 0
        };
      }
      procedureStats[procCode].revenue += revenue;
      procedureStats[procCode].quantity += quantity;
      procedureStats[procCode].count += 1;

      // Doctor procedure stats
      const key = `${doctorId}-${procCode}`;
      if (!doctorProcedureStats[key]) {
        doctorProcedureStats[key] = {
          doctorId,
          doctorName,
          procedureCode: procCode,
          procedureName: procName,
          revenue: 0,
          quantity: 0,
          count: 0
        };
      }
      doctorProcedureStats[key].revenue += revenue;
      doctorProcedureStats[key].quantity += quantity;
      doctorProcedureStats[key].count += 1;

      // Department stats
      if (!departmentProcedureStats[departmentId]) {
        departmentProcedureStats[departmentId] = {
          departmentId,
          departmentName: departmentId === 'unknown' ? 'Unknown' : 'Department',
          revenue: 0,
          count: 0
        };
      }
      departmentProcedureStats[departmentId].revenue += revenue;
      departmentProcedureStats[departmentId].count += 1;

      // Daily stats
      if (!dailyProcedureStats[dateKey]) {
        dailyProcedureStats[dateKey] = {
          date: dateKey,
          revenue: 0,
          quantity: 0,
          count: 0
        };
      }
      dailyProcedureStats[dateKey].revenue += revenue;
      dailyProcedureStats[dateKey].quantity += quantity;
      dailyProcedureStats[dateKey].count += 1;
    });

    // Calculate average price for each procedure
    Object.values(procedureStats).forEach(proc => {
      proc.averagePrice = proc.count > 0 ? proc.revenue / proc.count : 0;
    });

    // Calculate doctor commission for procedures
    const doctors = await Doctor.find({});
    const doctorCommissionMap = new Map();
    doctors.forEach(doc => {
      doctorCommissionMap.set(doc._id.toString(), {
        commissionPercentage: doc.revenuePercentage || (doc.isFullTime ? 100 : 30),
        isFullTime: doc.isFullTime,
        name: `${doc.firstName} ${doc.lastName || ''}`.trim(),
        department: doc.department
      });
    });

    const doctorProcedureStatsWithCommission = Object.values(doctorProcedureStats).map(stat => {
      const commissionInfo = doctorCommissionMap.get(stat.doctorId);
      const commissionPercentage = commissionInfo?.commissionPercentage || 30;
      const commission = stat.revenue * (commissionPercentage / 100);
      return {
        ...stat,
        doctorName: commissionInfo?.name || stat.doctorName,
        commission,
        commissionPercentage,
        hospitalShare: stat.revenue - commission,
        percentage: totalProcedureRevenue > 0 ? (stat.revenue / totalProcedureRevenue) * 100 : 0
      };
    });

    // Get department names
    const departments = await Department.find({});
    const deptMap = new Map(departments.map(d => [d._id.toString(), d.name]));

    // Format department data
    const departmentStats = Object.entries(departmentProcedureStats).map(([deptId, data]) => ({
      departmentId: deptId,
      departmentName: deptMap.get(deptId) || (deptId === 'unknown' ? 'Unknown' : 'Unknown Department'),
      revenue: data.revenue,
      count: data.count,
      percentage: totalProcedureRevenue > 0 ? (data.revenue / totalProcedureRevenue) * 100 : 0
    }));

    const response = {
      success: true,
      period: {
        start: startDate || startOfDayUTC.toISOString().split('T')[0],
        end: endDate || endOfDayUTC.toISOString().split('T')[0],
        dateRange: {
          from: startOfDayUTC,
          to: endOfDayUTC
        }
      },
      summary: {
        totalProcedureRevenue,
        totalProcedures: totalProcedureCount,
        uniqueProcedures: Object.keys(procedureStats).length,
        averageProcedureValue: totalProcedureCount > 0 ? totalProcedureRevenue / totalProcedureCount : 0,
        procedureCount: totalProcedureCount
      },
      breakdown: {
        byProcedure: Object.values(procedureStats)
          .map(p => ({
            ...p,
            percentage: totalProcedureRevenue > 0 ? (p.revenue / totalProcedureRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        byDoctor: doctorProcedureStatsWithCommission.sort((a, b) => b.revenue - a.revenue),
        byDepartment: departmentStats.sort((a, b) => b.revenue - a.revenue),
        daily: Object.values(dailyProcedureStats).sort((a, b) => new Date(a.date) - new Date(b.date))
      }
    };

    console.log('📊 Sending response with procedure revenue:', {
      total: totalProcedureRevenue,
      count: totalProcedureCount,
      procedures: Object.keys(procedureStats).length
    });

    res.json(response);

  } catch (error) {
    console.error('❌ Error in getProcedureRevenueAnalytics:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      stack: error.stack 
    });
  }
};

/**
 * Export Procedure Revenue Report with dual date field support
 */
exports.exportProcedureRevenue = async (req, res) => {
  try {
    const { startDate, endDate, exportType = 'csv', doctorId, departmentId } = req.query;

    // Use the procedure analytics function to get data
    const procedureData = await getProcedureRevenueData(req.query);

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      
      // Summary sheet
      const summarySheet = workbook.addWorksheet('Procedure Summary');
      summarySheet.columns = [
        { header: 'Metric', key: 'metric', width: 25 },
        { header: 'Value', key: 'value', width: 25 }
      ];

      summarySheet.addRow({ metric: 'Total Procedure Revenue', value: procedureData.summary.totalProcedureRevenue });
      summarySheet.addRow({ metric: 'Total Procedures', value: procedureData.summary.totalProcedures });
      summarySheet.addRow({ metric: 'Unique Procedures', value: procedureData.summary.uniqueProcedures });
      summarySheet.addRow({ metric: 'Average Procedure Value', value: procedureData.summary.averageProcedureValue });

      // Procedures sheet
      const procSheet = workbook.addWorksheet('Procedures');
      procSheet.columns = [
        { header: 'Code', key: 'code', width: 15 },
        { header: 'Name', key: 'name', width: 40 },
        { header: 'Revenue', key: 'revenue', width: 15 },
        { header: 'Count', key: 'count', width: 10 },
        { header: 'Avg Price', key: 'averagePrice', width: 15 },
        { header: 'Percentage', key: 'percentage', width: 12 }
      ];

      procedureData.breakdown.byProcedure.forEach(proc => {
        procSheet.addRow({
          code: proc.code,
          name: proc.name,
          revenue: proc.revenue,
          count: proc.count,
          averagePrice: proc.averagePrice,
          percentage: proc.percentage.toFixed(2) + '%'
        });
      });

      // Doctors sheet
      const doctorSheet = workbook.addWorksheet('By Doctor');
      doctorSheet.columns = [
        { header: 'Doctor', key: 'doctorName', width: 25 },
        { header: 'Procedure', key: 'procedureName', width: 40 },
        { header: 'Revenue', key: 'revenue', width: 15 },
        { header: 'Commission', key: 'commission', width: 15 },
        { header: 'Hospital Share', key: 'hospitalShare', width: 15 },
        { header: 'Count', key: 'count', width: 10 }
      ];

      procedureData.breakdown.byDoctor.forEach(doc => {
        doctorSheet.addRow({
          doctorName: doc.doctorName,
          procedureName: doc.procedureName,
          revenue: doc.revenue,
          commission: doc.commission,
          hospitalShare: doc.hospitalShare,
          count: doc.count
        });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=procedure_revenue_${startDate || 'all'}_to_${endDate || 'now'}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // CSV format
      const csvData = [
        ...procedureData.breakdown.byProcedure.map(p => ({
          Type: 'Procedure',
          Code: p.code,
          Name: p.name,
          Revenue: p.revenue,
          Count: p.count,
          'Avg Price': p.averagePrice,
          Percentage: p.percentage.toFixed(2) + '%'
        })),
        ...procedureData.breakdown.byDoctor.map(d => ({
          Type: 'Doctor',
          Doctor: d.doctorName,
          Procedure: d.procedureName,
          Revenue: d.revenue,
          Commission: d.commission,
          'Hospital Share': d.hospitalShare,
          Count: d.count
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
      res.setHeader('Content-Disposition', `attachment; filename=procedure_revenue_${startDate || 'all'}_to_${endDate || 'now'}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting procedure revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Helper function to get procedure data with dual date field support
 */
async function getProcedureRevenueData(query) {
  const { startDate, endDate, doctorId, departmentId } = query;

  const dateFilter = {};
  if (startDate && endDate) {
    dateFilter.$or = [
      { created_at: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } },
      { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } }
    ];
  }

  const pipeline = [
    { $match: { invoice_type: 'Procedure', ...dateFilter } },
    { $unwind: '$procedure_items' },
    {
      $lookup: {
        from: 'appointments',
        localField: 'appointment_id',
        foreignField: '_id',
        as: 'appointment'
      }
    },
    { $unwind: { path: '$appointment', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'doctors',
        localField: 'appointment.doctor_id',
        foreignField: '_id',
        as: 'doctor'
      }
    },
    { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        procedureCode: '$procedure_items.procedure_code',
        procedureName: '$procedure_items.procedure_name',
        procedureRevenue: '$procedure_items.total_price',
        procedureQuantity: '$procedure_items.quantity',
        doctorId: '$doctor._id',
        doctorName: { $concat: ['$doctor.firstName', ' ', { $ifNull: ['$doctor.lastName', ''] }] },
        departmentId: '$doctor.department',
        date: { 
          $dateToString: { 
            format: '%Y-%m-%d', 
            date: { $ifNull: ['$created_at', '$createdAt'] }
          } 
        }
      }
    }
  ];

  if (doctorId && doctorId !== 'all') {
    pipeline.push({ $match: { 'appointment.doctor_id': new mongoose.Types.ObjectId(doctorId) } });
  }

  if (departmentId && departmentId !== 'all') {
    pipeline.push({ $match: { 'doctor.department': new mongoose.Types.ObjectId(departmentId) } });
  }

  const procedureInvoices = await Invoice.aggregate(pipeline);

  // Group by procedure code
  const procedureStats = {};
  const doctorProcedureStats = {};
  const dailyProcedureStats = {};

  let totalProcedureRevenue = 0;
  let totalProcedureCount = 0;

  procedureInvoices.forEach(item => {
    const procCode = item.procedureCode;
    const procName = item.procedureName;
    const revenue = item.procedureRevenue || 0;
    const quantity = item.procedureQuantity || 1;
    const doctorId = item.doctorId ? item.doctorId.toString() : 'unknown';
    const doctorName = item.doctorName || 'Unknown';
    const dateKey = item.date;

    totalProcedureRevenue += revenue;
    totalProcedureCount += 1;

    if (!procedureStats[procCode]) {
      procedureStats[procCode] = {
        code: procCode,
        name: procName,
        revenue: 0,
        quantity: 0,
        count: 0,
        averagePrice: 0
      };
    }
    procedureStats[procCode].revenue += revenue;
    procedureStats[procCode].quantity += quantity;
    procedureStats[procCode].count += 1;

    const key = `${doctorId}-${procCode}`;
    if (!doctorProcedureStats[key]) {
      doctorProcedureStats[key] = {
        doctorId,
        doctorName,
        procedureCode: procCode,
        procedureName: procName,
        revenue: 0,
        quantity: 0,
        count: 0
      };
    }
    doctorProcedureStats[key].revenue += revenue;
    doctorProcedureStats[key].quantity += quantity;
    doctorProcedureStats[key].count += 1;

    if (!dailyProcedureStats[dateKey]) {
      dailyProcedureStats[dateKey] = {
        date: dateKey,
        revenue: 0,
        quantity: 0,
        count: 0
      };
    }
    dailyProcedureStats[dateKey].revenue += revenue;
    dailyProcedureStats[dateKey].quantity += quantity;
    dailyProcedureStats[dateKey].count += 1;
  });

  Object.values(procedureStats).forEach(proc => {
    proc.averagePrice = proc.count > 0 ? proc.revenue / proc.count : 0;
  });

  const doctors = await Doctor.find({});
  const doctorCommissionMap = new Map();
  doctors.forEach(doc => {
    doctorCommissionMap.set(doc._id.toString(), {
      commissionPercentage: doc.revenuePercentage || (doc.isFullTime ? 100 : 30),
      isFullTime: doc.isFullTime,
      name: `${doc.firstName} ${doc.lastName || ''}`.trim()
    });
  });

  const doctorProcedureStatsWithCommission = Object.values(doctorProcedureStats).map(stat => {
    const commissionInfo = doctorCommissionMap.get(stat.doctorId);
    const commissionPercentage = commissionInfo?.commissionPercentage || 30;
    const commission = stat.revenue * (commissionPercentage / 100);
    return {
      ...stat,
      doctorName: commissionInfo?.name || stat.doctorName,
      commission,
      commissionPercentage,
      hospitalShare: stat.revenue - commission,
      percentage: totalProcedureRevenue > 0 ? (stat.revenue / totalProcedureRevenue) * 100 : 0
    };
  });

  return {
    summary: {
      totalProcedureRevenue,
      totalProcedures: totalProcedureCount,
      uniqueProcedures: Object.keys(procedureStats).length,
      averageProcedureValue: totalProcedureCount > 0 ? totalProcedureRevenue / totalProcedureCount : 0
    },
    breakdown: {
      byProcedure: Object.values(procedureStats).map(p => ({
        ...p,
        percentage: totalProcedureRevenue > 0 ? (p.revenue / totalProcedureRevenue) * 100 : 0
      })),
      byDoctor: doctorProcedureStatsWithCommission,
      daily: Object.values(dailyProcedureStats)
    }
  };
}

/**
 * Daily revenue report with dual date field support
 */
exports.getDailyRevenueReport = async (req, res) => {
  try {
    const { date, doctorId, departmentId, invoiceType, paymentMethod } = req.query;

    // Get the date string (YYYY-MM-DD) - this represents the IST day
    const dateStr = date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    
    // Create IST date objects
    const istDate = new Date(`${dateStr}T00:00:00.000+05:30`); // IST midnight
    const istEndDate = new Date(`${dateStr}T23:59:59.999+05:30`); // IST end of day
    
    // Convert to UTC for database query
    const startOfDayUTC = new Date(istDate.toISOString()); // This will be previous day 18:30 UTC
    const endOfDayUTC = new Date(istEndDate.toISOString()); // This will be current day 18:29 UTC

    console.log(`📅 Daily Report for IST Date: ${dateStr}`);
    console.log(`🇮🇳 IST Range: ${istDate.toLocaleString('en-IN')} to ${istEndDate.toLocaleString('en-IN')}`);
    console.log(`🌍 UTC Query Range: ${startOfDayUTC.toISOString()} to ${endOfDayUTC.toISOString()}`);

    // Build the match stage using UTC timestamps with dual field support
    const matchStage = {
      $or: [
        { created_at: { $gte: startOfDayUTC, $lte: endOfDayUTC } },
        { createdAt: { $gte: startOfDayUTC, $lte: endOfDayUTC } }
      ]
    };

    // Add optional filters
    if (invoiceType) {
      matchStage.invoice_type = invoiceType;
    }

    // Get all invoices for the day
    const invoices = await Invoice.find(matchStage)
      .populate('patient_id', 'first_name last_name patientId')
      .populate({
        path: 'appointment_id',
        populate: {
          path: 'doctor_id',
          select: 'firstName lastName specialization revenuePercentage isFullTime'
        }
      })
      .lean();

    console.log(`✅ Found ${invoices.length} invoices for IST date ${dateStr}`);

    // Log the first few invoices to verify they're from correct IST day
    if (invoices.length > 0) {
      console.log('Sample invoices with IST conversion:');
      invoices.slice(0, 3).forEach(inv => {
        const dateField = inv.created_at || inv.createdAt;
        const istTime = new Date(dateField).toLocaleString('en-IN', { 
          timeZone: 'Asia/Kolkata',
          dateStyle: 'full',
          timeStyle: 'long'
        });
        console.log(`- Invoice ${inv.invoice_number}: UTC=${dateField}, IST=${istTime}`);
      });
    }

    // Initialize counters
    let totalRevenue = 0;
    let totalPaid = 0;
    let totalPending = 0;
    
    const revenueByType = {
      Appointment: 0,
      Pharmacy: 0,
      Procedure: 0,
      Mixed: 0,
      Other: 0
    };

    const countByType = {
      Appointment: 0,
      Pharmacy: 0,
      Procedure: 0,
      Mixed: 0,
      Other: 0
    };

    const revenueByStatus = {
      Paid: 0,
      Partial: 0,
      Pending: 0,
      Overdue: 0,
      Draft: 0,
      Cancelled: 0
    };

    const doctorRevenue = {};
    const paymentMethods = {};
    const hourlyDataIST = Array(24).fill(0).map(() => ({ count: 0, revenue: 0 })); // For IST hours

    // Process each invoice
    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const paid = invoice.amount_paid || 0;
      const pending = invoice.balance_due || 0;
      
      // Only count paid/revenue from non-draft/cancelled invoices
      if (!['Draft', 'Cancelled'].includes(invoice.status)) {
        totalRevenue += amount;
        totalPaid += paid;
        totalPending += pending;

        // Revenue by invoice type
        const type = invoice.invoice_type || 'Other';
        if (revenueByType.hasOwnProperty(type)) {
          revenueByType[type] += amount;
          countByType[type] += 1;
        } else {
          revenueByType.Other += amount;
          countByType.Other += 1;
        }

        // Revenue by status
        if (revenueByStatus.hasOwnProperty(invoice.status)) {
          revenueByStatus[invoice.status] += amount;
        }

        // Doctor revenue breakdown
        const doctor = invoice.appointment_id?.doctor_id;
        if (doctor) {
          const doctorId = doctor._id.toString();
          const doctorName = `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim() || 'Unknown';
          const commissionPercent = doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30);
          const commission = (amount * commissionPercent) / 100;
          
          if (!doctorRevenue[doctorId]) {
            doctorRevenue[doctorId] = {
              doctorId,
              name: doctorName,
              revenue: 0,
              commission: 0,
              commissionPercent,
              invoiceCount: 0,
              specialization: doctor.specialization || 'General'
            };
          }
          
          doctorRevenue[doctorId].revenue += amount;
          doctorRevenue[doctorId].commission += commission;
          doctorRevenue[doctorId].invoiceCount += 1;
        }

        // Payment methods breakdown
        if (invoice.payment_history && invoice.payment_history.length > 0) {
          invoice.payment_history.forEach(payment => {
            const method = payment.method || 'Unknown';
            paymentMethods[method] = (paymentMethods[method] || 0) + (payment.amount || 0);
          });
        }

        // Hourly breakdown - Convert UTC to IST hour
        const dateField = invoice.created_at || invoice.createdAt;
        const istHour = new Date(dateField).toLocaleString('en-US', { 
          timeZone: 'Asia/Kolkata',
          hour: 'numeric',
          hour12: false 
        });
        const hour = parseInt(istHour);
        
        hourlyDataIST[hour].count += 1;
        hourlyDataIST[hour].revenue += amount;
      }
    });

    // Format doctor breakdown as array
    const doctorBreakdown = Object.values(doctorRevenue).sort((a, b) => b.revenue - a.revenue);

    // Format payment method breakdown
    const totalPayments = Object.values(paymentMethods).reduce((a, b) => a + b, 0);
    const paymentMethodBreakdown = Object.entries(paymentMethods).map(([method, amount]) => ({
      method,
      amount,
      percentage: totalPayments > 0 ? Number(((amount / totalPayments) * 100).toFixed(2)) : 0
    })).sort((a, b) => b.amount - a.amount);

    // Calculate hospital share (revenue minus doctor commissions)
    const totalCommission = doctorBreakdown.reduce((sum, doc) => sum + doc.commission, 0);
    const hospitalRevenue = totalRevenue - totalCommission;

    // Find busiest hour (IST)
    let busiestHour = 0;
    let maxRevenue = 0;
    hourlyDataIST.forEach((data, hour) => {
      if (data.revenue > maxRevenue) {
        maxRevenue = data.revenue;
        busiestHour = hour;
      }
    });

    // Format hourly breakdown (IST hours)
    const hourlyBreakdown = hourlyDataIST.map((data, hour) => ({
      hour: `${String(hour).padStart(2, '0')}:00 IST`,
      count: data.count,
      revenue: Number(data.revenue.toFixed(2)),
      percentage: totalRevenue > 0 ? Number(((data.revenue / totalRevenue) * 100).toFixed(2)) : 0
    }));

    // Prepare the response
    const response = {
      success: true,
      reportDate: {
        requested: dateStr,
        timezone: 'Asia/Kolkata'
      },
      queryRange: {
        ist: {
          start: istDate.toLocaleString('en-IN'),
          end: istEndDate.toLocaleString('en-IN')
        },
        utc: {
          start: startOfDayUTC.toISOString(),
          end: endOfDayUTC.toISOString()
        }
      },
      summary: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        totalPending: Number(totalPending.toFixed(2)),
        hospitalRevenue: Number(hospitalRevenue.toFixed(2)),
        totalCommission: Number(totalCommission.toFixed(2)),
        collectionRate: totalRevenue > 0 ? Number(((totalPaid / totalRevenue) * 100).toFixed(2)) : 0,
        invoiceCount: invoices.length
      },
      breakdown: {
        byType: Object.entries(revenueByType)
          .filter(([_, amount]) => amount > 0)
          .map(([type, amount]) => ({
            type,
            amount: Number(amount.toFixed(2)),
            count: countByType[type],
            percentage: totalRevenue > 0 ? Number(((amount / totalRevenue) * 100).toFixed(2)) : 0,
            average: countByType[type] > 0 ? Number((amount / countByType[type]).toFixed(2)) : 0
          })),
        byStatus: Object.entries(revenueByStatus)
          .filter(([_, amount]) => amount > 0)
          .map(([status, amount]) => ({
            status,
            amount: Number(amount.toFixed(2)),
            percentage: totalRevenue > 0 ? Number(((amount / totalRevenue) * 100).toFixed(2)) : 0
          })),
        byDoctor: doctorBreakdown.map(doc => ({
          ...doc,
          revenue: Number(doc.revenue.toFixed(2)),
          commission: Number(doc.commission.toFixed(2)),
          hospitalShare: Number((doc.revenue - doc.commission).toFixed(2)),
          percentage: totalRevenue > 0 ? Number(((doc.revenue / totalRevenue) * 100).toFixed(2)) : 0
        })),
        byPaymentMethod: paymentMethodBreakdown,
        hourly: hourlyBreakdown
      },
      metrics: {
        averageInvoiceValue: invoices.length > 0 ? Number((totalRevenue / invoices.length).toFixed(2)) : 0,
        busiestHour: {
          hour: `${String(busiestHour).padStart(2, '0')}:00 IST`,
          revenue: Number(maxRevenue.toFixed(2)),
          count: hourlyDataIST[busiestHour].count
        },
        paidVsPending: {
          paid: Number(totalPaid.toFixed(2)),
          pending: Number(totalPending.toFixed(2)),
          ratio: totalPaid > 0 ? Number((totalPaid / (totalPending || 1)).toFixed(2)) : 0
        }
      },
      recentInvoices: invoices.slice(0, 20).map(inv => {
        const dateField = inv.created_at || inv.createdAt;
        const istTime = new Date(dateField).toLocaleString('en-IN', { 
          timeZone: 'Asia/Kolkata',
          dateStyle: 'full',
          timeStyle: 'long'
        });
        
        return {
          invoiceNumber: inv.invoice_number,
          type: inv.invoice_type,
          patient: inv.patient_id ? 
            `${inv.patient_id.first_name || ''} ${inv.patient_id.last_name || ''}`.trim() : 
            'Walk-in',
          doctor: inv.appointment_id?.doctor_id ?
            `${inv.appointment_id.doctor_id.firstName || ''} ${inv.appointment_id.doctor_id.lastName || ''}`.trim() :
            'Not assigned',
          amount: inv.total,
          paid: inv.amount_paid,
          status: inv.status,
          timeIST: istTime,
          timeUTC: dateField
        };
      })
    };

    // Add applied filters if any
    if (doctorId || departmentId || invoiceType || paymentMethod) {
      response.appliedFilters = {
        ...(doctorId && { doctorId }),
        ...(departmentId && { departmentId }),
        ...(invoiceType && { invoiceType }),
        ...(paymentMethod && { paymentMethod })
      };
    }

    res.json(response);

  } catch (error) {
    console.error('❌ Error in getDailyRevenueReport:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate daily revenue report',
      details: error.message 
    });
  }
};

/**
 * Monthly revenue report with dual date field support
 */
/**
 * Monthly revenue report with dual date field support - FIXED
 */
exports.getMonthlyRevenueReport = async (req, res) => {
  try {
    const { year, month, doctorId, department, invoiceType, paymentMethod, patientType } = req.query;

    const targetYear = parseInt(year, 10) || new Date().getFullYear();
    const targetMonth = parseInt(month, 10) || new Date().getMonth() + 1;

    // Create date range safely
    const startDate = new Date(Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999));

    console.log(`Monthly report for: ${targetYear}-${targetMonth}`);
    console.log('Date range:', { 
      start: startDate.toISOString(), 
      end: endDate.toISOString() 
    });

    // Build query with dual field support
    const query = {
      $or: [
        { created_at: { $gte: startDate, $lte: endDate } },
        { createdAt: { $gte: startDate, $lte: endDate } }
      ]
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
      })
      .lean();

    console.log(`Found ${invoices.length} invoices for monthly report`);

    // Apply additional filters in JavaScript (simpler approach)
    if (doctorId && doctorId !== 'all') {
      invoices = invoices.filter(inv => 
        inv.appointment_id?.doctor_id?._id?.toString() === doctorId
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
      
      // SAFELY get the date field - FIXED
      let dateField;
      if (inv.created_at) {
        dateField = inv.created_at;
      } else if (inv.createdAt) {
        dateField = inv.createdAt;
      } else {
        dateField = new Date(); // fallback to current date
      }

      // Convert to Date object if it's a string
      const dateObj = dateField instanceof Date ? dateField : new Date(dateField);
      
      // Check if date is valid before using it
      if (isNaN(dateObj.getTime())) {
        console.warn('Invalid date found for invoice:', inv.invoice_number);
        return; // Skip this invoice if date is invalid
      }

      const day = dateObj.getDate();
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

      // Daily breakdown - FIXED: Create date string safely
      const dateKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = {
          date: dateKey,
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

    let highestRevenueDay = { revenue: 0, date: '' };
    Object.values(dailyBreakdown).forEach((d) => {
      if (d.revenue > highestRevenueDay.revenue) {
        highestRevenueDay = d;
      }
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
      
      // SAFELY get date for last visit
      let dateField;
      if (inv.created_at) {
        dateField = inv.created_at;
      } else if (inv.createdAt) {
        dateField = inv.createdAt;
      } else {
        return; // Skip if no valid date
      }
      
      const dateObj = dateField instanceof Date ? dateField : new Date(dateField);
      if (!isNaN(dateObj.getTime())) {
        const t = dateObj.getTime();
        if (!patientLastVisit[pId] || t > patientLastVisit[pId]) {
          patientLastVisit[pId] = t;
        }
      }
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
      (a, b) => a.date.localeCompare(b.date)
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
 * Doctor revenue report with dual date field support
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

    // invoice-only match first with dual date support
    const match = { 
      $or: [
        { created_at: { $gte: start, $lte: end } },
        { createdAt: { $gte: start, $lte: end } }
      ]
    };
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

    // Add computed date field
    pipeline.push({
      $addFields: {
        computed_date: { $ifNull: ['$created_at', '$createdAt'] }
      }
    });

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

      const dateKey = new Date(inv.computed_date || inv.created_at || inv.createdAt).toISOString().split('T')[0];
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
 * Department revenue report with dual date field support
 */
exports.getDepartmentRevenue = async (req, res) => {
  try {
    const { department, startDate, endDate } = req.query;

    const deptObjId = toObjectId(department);
    if (!deptObjId) return res.status(400).json({ error: 'Invalid department' });

    const dateMatch = {};
    if (startDate && endDate) {
      dateMatch.$or = [
        { created_at: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } },
        { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } }
      ];
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
      { $unwind: { path: '$doctor_info', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          computed_date: { $ifNull: ['$created_at', '$createdAt'] }
        }
      }
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

      const dateKey = new Date(inv.computed_date || inv.created_at || inv.createdAt).toISOString().split('T')[0];
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
        start: startDate ? new Date(startDate) : null,
        end: endDate ? new Date(endDate + 'T23:59:59.999Z') : null
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
 * Detailed transactions report (paginated) with dual date field support
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
      { $sort: { computed_date: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit, 10) },
      {
        $project: {
          invoice_number: 1,
          invoice_type: 1,
          issue_date: { $ifNull: ['$issue_date', { $ifNull: ['$created_at', '$createdAt'] }] },
          total: 1,
          amount_paid: 1,
          balance_due: 1,
          status: 1,
          created_at: 1,
          createdAt: 1,
          computed_date: 1,
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
 * Export revenue data - Comprehensive with bifurcation and dual date field support
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

    // Build filter with dual date field support
    const filter = {};
    if (startDate && endDate) {
      filter.$or = [
        { created_at: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } },
        { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } }
      ];
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
      const dateField = invoice.created_at || invoice.createdAt;

      return {
        'Invoice Number': invoice.invoice_number,
        'Date': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[0] : (dateField ? new Date(dateField).toISOString().split('T')[0] : ''),
        'Time': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[1].split('.')[0] : (dateField ? new Date(dateField).toISOString().split('T')[1].split('.')[0] : ''),
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
          start: startDate ? new Date(startDate) : null,
          end: endDate ? new Date(endDate + 'T23:59:59.999Z') : null
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
 * Export Overview Data with dual date field support
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
 * Export Daily Report with dual date field support
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
      const dateField = invoice.created_at || invoice.createdAt;
      const hour = new Date(dateField).getHours();
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
 * Export Monthly Report with dual date field support
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
        dayOfMonth: { $dayOfMonth: { $ifNull: ['$created_at', '$createdAt'] } }
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
 * Export Doctor Report with dual date field support
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

    // invoice-only match first with dual date support
    const match = { 
      $or: [
        { created_at: { $gte: start, $lte: end } },
        { createdAt: { $gte: start, $lte: end } }
      ]
    };
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
 * Export Department Report with dual date field support
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
      dateMatch.$or = [
        { created_at: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } },
        { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } }
      ];
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
      'Average Commission Rate': totalRevenue > 0 ? `${(totalCommission / totalRevenue * 100).toFixed(1)}%` : '0%',
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
 * Export Detailed Report with dual date field support
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

    // Build filter with dual date field support
    const filter = {};
    if (startDate && endDate) {
      filter.$or = [
        { created_at: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } },
        { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } }
      ];
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
      const dateField = invoice.created_at || invoice.createdAt;

      return {
        'Invoice Number': invoice.invoice_number,
        'Date': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[0] : (dateField ? new Date(dateField).toISOString().split('T')[0] : ''),
        'Time': invoice.issue_date ? invoice.issue_date.toISOString().split('T')[1].split('.')[0] : (dateField ? new Date(dateField).toISOString().split('T')[1].split('.')[0] : ''),
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