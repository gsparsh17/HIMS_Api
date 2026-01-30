// controllers/revenue.controller.js
const Salary = require('../models/Salary');
const Invoice = require('../models/Invoice');
const Doctor = require('../models/Doctor');
const Patient = require('../models/Patient');
const mongoose = require('mongoose');

const toObjectId = (id) => {
  try {
    if (!id) return null;
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
};

/**
 * Build invoice aggregation pipeline with correct joins + filters.
 * Fixes:
 * - doctor filter via appointment lookup
 * - department filter via doctor lookup
 * - patientType filter via patient lookup
 * - avoids matching on non-existent invoice.doctor_id / appointment_id.doctor_id / invoice.department
 */
function buildInvoicePipeline(query, opts = {}) {
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
  } = query;

  const { requireDoctorJoin = false, requirePatientJoin = false } = opts;

  const pipeline = [];

  // Date range (default last 30 days if not provided)
  const dateMatch = {};
  if (startDate && endDate) {
    dateMatch.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
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
  const deptObjId = department && department !== 'all' ? toObjectId(department) : null;
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
      ? await Doctor.find({ _id: { $in: topDoctorIds } }).select('firstName lastName department specialization')
      : [];
    const doctorMap = new Map(doctorDocs.map((d) => [String(d._id), d]));

    const topDoctors = topDoctorIds.map((id) => {
      const d = doctorMap.get(String(id));
      const revenue = doctorRevenue[String(id)] || 0;
      return {
        doctorId: String(id),
        name: d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown',
        revenue,
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
 * Fixes:
 * - correct doctor filter via appointment lookup
 * - correct department filter via doctor lookup
 * - no invalid invoice.department match
 */
exports.getDailyRevenueReport = async (req, res) => {
  try {
    const { date, doctorId, department, invoiceType, paymentMethod } = req.query;

    // Build day boundaries in UTC from provided YYYY-MM-DD (keeps your previous behavior)
    // If you want IST day boundaries, tell me and I'll switch to Luxon approach.
    const target = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
    const startOfDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const baseQuery = {
      startDate: startOfDay.toISOString(),
      endDate: endOfDay.toISOString(),
      doctorId,
      department,
      invoiceType,
      paymentMethod
    };

    const { pipeline } = buildInvoicePipeline(baseQuery, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure doctor_info for department breakdown + names
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
      const hour = new Date(inv.createdAt).getHours();

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

        if (!doctorBreakdown[docId]) {
          doctorBreakdown[docId] = {
            doctorId: docId,
            name: docName,
            revenue: 0,
            invoices: 0,
            department: inv.doctor_info?.department || 'Unknown'
          };
        }
        doctorBreakdown[docId].revenue += amount;
        doctorBreakdown[docId].invoices += 1;

        const deptKey = inv.doctor_info?.department ? String(inv.doctor_info.department) : 'Unknown';
        departmentBreakdown[deptKey] = (departmentBreakdown[deptKey] || 0) + amount;
      } else {
        departmentBreakdown['Unknown'] = (departmentBreakdown['Unknown'] || 0) + amount;
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

    const departmentBreakdownArray = Object.entries(departmentBreakdown)
      .map(([deptId, revenue]) => ({
        departmentId: deptId,
        revenue,
        percentage: totalRevenue > 0 ? Number(((revenue / totalRevenue) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);

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
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0
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
 * Fixes:
 * - correct doctor filter via appointment lookup
 * - correct department filter via doctor lookup
 * - correct patientType via patient lookup (no JS post-filtering)
 * - no N+1 for doctor/patient details
 */
exports.getMonthlyRevenueReport = async (req, res) => {
  try {
    const { year, month, doctorId, department, invoiceType, paymentMethod, patientType } = req.query;

    const targetYear = parseInt(year, 10) || new Date().getFullYear();
    const targetMonth = parseInt(month, 10) || new Date().getMonth() + 1;

    const startOfMonth = new Date(Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0, 0));
    const endOfMonth = new Date(Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999));

    const baseQuery = {
      startDate: startOfMonth.toISOString(),
      endDate: endOfMonth.toISOString(),
      doctorId,
      department,
      patientType,
      invoiceType,
      paymentMethod
    };

    const { pipeline } = buildInvoicePipeline(baseQuery, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure doctor_info for later breakdown + details
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
      const day = inv.dayOfMonth;
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

      if (!weeklyBreakdown[week]) {
        weeklyBreakdown[week] = {
          week,
          startDay: (week - 1) * 7 + 1,
          endDay: Math.min(week * 7, new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()),
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

      const docId = inv.appointment_info?.doctor_id ? String(inv.appointment_info.doctor_id) : null;
      if (docId) doctorBreakdown[docId] = (doctorBreakdown[docId] || 0) + amount;

      if (inv.patient_id) {
        const pId = String(inv.patient_id);
        patientBreakdown[pId] = (patientBreakdown[pId] || 0) + amount;
      }

      if (Array.isArray(inv.payment_history) && inv.payment_history.length) {
        inv.payment_history.forEach((p) => {
          const method = p.method || 'Unknown';
          paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + (p.amount || 0);
        });
      }
    });

    // Salary expenses for month: consistent paid_date
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          paid_date: { $gte: startOfMonth, $lte: endOfMonth },
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

    // Doctor details (no N+1)
    const topDoctorIds = Object.entries(doctorBreakdown)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([id]) => toObjectId(id))
      .filter(Boolean);

    const doctorDocs = topDoctorIds.length
      ? await Doctor.find({ _id: { $in: topDoctorIds } }).select('firstName lastName department specialization')
      : [];
    const doctorMap = new Map(doctorDocs.map((d) => [String(d._id), d]));

    const doctorDetails = topDoctorIds.map((id) => {
      const d = doctorMap.get(String(id));
      return {
        doctorId: String(id),
        name: d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown',
        revenue: doctorBreakdown[String(id)] || 0,
        appointments: invoices.filter(
          (inv) => inv.invoice_type === 'Appointment' && String(inv.appointment_info?.doctor_id || '') === String(id)
        ).length,
        department: d?.department || 'Unknown',
        specialization: d?.specialization || 'N/A'
      };
    });

    // Patient details (no N+1)
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
      const pId = String(inv.patient_id);
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
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0,
        expenseRatio: totalRevenue > 0 ? Number(((totalSalaryExpenses / totalRevenue) * 100).toFixed(2)) : 0
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
        byDoctor: doctorDetails,
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
 * Fixes:
 * - uses appointment lookup to filter by doctor
 * - no invalid invoice.doctor_id match
 */
exports.getDoctorRevenue = async (req, res) => {
  try {
    const { doctorId, startDate, endDate, invoiceType } = req.query;

    const doctorObjId = toObjectId(doctorId);
    if (!doctorObjId) return res.status(400).json({ error: 'Invalid doctorId' });

    // Default last 30 days if no dates
    let start = startDate ? new Date(startDate) : null;
    let end = endDate ? new Date(endDate) : null;

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

    let totalRevenue = 0;
    let appointmentCount = 0;
    let procedureCount = 0;

    const dailyRevenue = {};
    const patientBreakdown = {};
    const serviceBreakdown = {};

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      totalRevenue += amount;

      if (inv.invoice_type === 'Appointment') appointmentCount += 1;
      if (inv.invoice_type === 'Procedure') procedureCount += 1;

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

      if (Array.isArray(inv.service_items) && inv.service_items.length) {
        inv.service_items.forEach((item) => {
          const serviceType = item.service_type || 'Other';
          serviceBreakdown[serviceType] = (serviceBreakdown[serviceType] || 0) + (item.total_price || 0);
        });
      }
    });

    const doctor = await Doctor.findById(doctorObjId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([d, revenue]) => ({ date: d, revenue }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const patientBreakdownArray = Object.values(patientBreakdown).sort((a, b) => b.revenue - a.revenue);

    const serviceBreakdownArray = Object.entries(serviceBreakdown)
      .map(([service, revenue]) => ({
        service,
        revenue,
        percentage: totalRevenue > 0 ? Number(((revenue / totalRevenue) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      doctor: {
        id: doctor._id,
        name: `${doctor.firstName} ${doctor.lastName || ''}`.trim(),
        department: doctor.department,
        specialization: doctor.specialization,
        licenseNumber: doctor.licenseNumber
      },
      period: { start, end },
      summary: {
        totalRevenue,
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
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
 * Fixes:
 * - invoice match uses appointment lookup then matches doctor_id in department
 * - no invalid appointment_id.doctor_id match
 */
exports.getDepartmentRevenue = async (req, res) => {
  try {
    const { department, startDate, endDate } = req.query;

    const deptObjId = toObjectId(department);
    if (!deptObjId) return res.status(400).json({ error: 'Invalid department' });

    const dateMatch = {};
    if (startDate && endDate) {
      dateMatch.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    // Get doctors in department
    const doctors = await Doctor.find({ department: deptObjId }).select('firstName lastName specialization department');
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

    let totalRevenue = 0;
    let appointmentCount = 0;
    let procedureCount = 0;

    const doctorBreakdown = {};
    const dailyRevenue = {};

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      totalRevenue += amount;

      if (inv.invoice_type === 'Appointment') appointmentCount += 1;
      if (inv.invoice_type === 'Procedure') procedureCount += 1;

      const dateKey = new Date(inv.createdAt).toISOString().split('T')[0];
      dailyRevenue[dateKey] = (dailyRevenue[dateKey] || 0) + amount;

      const docId = inv.appointment_info?.doctor_id ? String(inv.appointment_info.doctor_id) : null;
      if (docId) {
        const d = inv.doctor_info;
        const name = d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown';

        if (!doctorBreakdown[docId]) {
          doctorBreakdown[docId] = {
            id: docId,
            name,
            revenue: 0,
            invoices: 0,
            specialization: d?.specialization || 'N/A'
          };
        }
        doctorBreakdown[docId].revenue += amount;
        doctorBreakdown[docId].invoices += 1;
      }
    });

    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([d, revenue]) => ({ date: d, revenue }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const doctorBreakdownArray = Object.values(doctorBreakdown).sort((a, b) => b.revenue - a.revenue);

    res.json({
      department: String(deptObjId),
      period: {
        start: dateMatch.createdAt?.$gte || null,
        end: dateMatch.createdAt?.$lte || null
      },
      summary: {
        totalRevenue,
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
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
        revenue: doctorBreakdown[String(d._id)]?.revenue || 0,
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
 * Fixes:
 * - correct doctor filter via lookup/unwind
 * - department filter implemented
 * - doctor lookup stage order fixed (unwind appointment before doctor lookup)
 * - count uses same base invoice-only filters (department/doctor filters require aggregate count)
 */
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

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    // Build pipeline with joins for doctor/department filters
    const baseQuery = {
      startDate,
      endDate,
      doctorId,
      department,
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
            department: '$doctor_info.department'
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

    const summary = {
      totalRevenue: invoices.reduce((sum, inv) => sum + (inv.total || 0), 0),
      totalPaid: invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0),
      totalPending: invoices.reduce((sum, inv) => sum + (inv.balance_due || 0), 0),
      totalInvoices: invoices.length,
      appointmentCount: invoices.filter((inv) => inv.invoice_type === 'Appointment').length,
      pharmacyCount: invoices.filter((inv) => inv.invoice_type === 'Pharmacy').length,
      procedureCount: invoices.filter((inv) => inv.invoice_type === 'Procedure').length
    };

    res.json({
      period: { start: period.start || null, end: period.end || null },
      summary,
      transactions: invoices,
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
 * Export revenue data
 * Fixes:
 * - uses populate safely
 * - exportType=csv returns downloadable CSV
 * - exportType=json returns data
 * Note: true Excel needs exceljs; keeping your CSV export behavior but aligning flags.
 */
exports.exportRevenueData = async (req, res) => {
  try {
    const { startDate, endDate, exportType = 'csv' } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId patient_type')
      .populate({
        path: 'appointment_id',
        populate: { path: 'doctor_id', select: 'firstName lastName department' }
      })
      .sort({ createdAt: -1 })
      .limit(10000);

    const exportData = invoices.map((invoice) => {
      const doctor = invoice.appointment_id?.doctor_id;
      const patient = invoice.patient_id;

      return {
        'Invoice Number': invoice.invoice_number,
        Date: invoice.issue_date ? invoice.issue_date.toISOString().split('T')[0] : '',
        Type: invoice.invoice_type,
        'Patient Name': patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : 'Unknown',
        'Patient ID': patient?.patientId || 'N/A',
        Doctor: doctor ? `${doctor.firstName} ${doctor.lastName || ''}`.trim() : 'N/A',
        Department: doctor?.department || 'N/A',
        'Total Amount': invoice.total || 0,
        'Amount Paid': invoice.amount_paid || 0,
        'Balance Due': invoice.balance_due || 0,
        Status: invoice.status,
        'Payment Method':
          Array.isArray(invoice.payment_history) && invoice.payment_history.length
            ? invoice.payment_history[invoice.payment_history.length - 1].method
            : 'N/A',
        'Services Count': invoice.service_items?.length || 0,
        'Medicines Count': invoice.medicine_items?.length || 0,
        'Procedures Count': invoice.procedure_items?.length || 0,
        Notes: invoice.notes || ''
      };
    });

    const summaryRow = {
      'Invoice Number': 'SUMMARY',
      Date: '',
      Type: '',
      'Patient Name': '',
      'Patient ID': '',
      Doctor: '',
      Department: '',
      'Total Amount': invoices.reduce((sum, inv) => sum + (inv.total || 0), 0),
      'Amount Paid': invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0),
      'Balance Due': invoices.reduce((sum, inv) => sum + (inv.balance_due || 0), 0),
      Status: '',
      'Payment Method': '',
      'Services Count': invoices.reduce((sum, inv) => sum + (inv.service_items?.length || 0), 0),
      'Medicines Count': invoices.reduce((sum, inv) => sum + (inv.medicine_items?.length || 0), 0),
      'Procedures Count': invoices.reduce((sum, inv) => sum + (inv.procedure_items?.length || 0), 0),
      Notes: `Total Invoices: ${invoices.length} | Period: ${startDate || 'Start'} to ${endDate || 'End'}`
    };

    exportData.unshift(summaryRow);

    if (exportType === 'json') {
      return res.json({
        period: {
          start: filter.createdAt?.$gte || null,
          end: filter.createdAt?.$lte || null
        },
        data: exportData,
        total: invoices.length
      });
    }

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
  } catch (error) {
    console.error('Error exporting revenue data:', error);
    res.status(500).json({ error: error.message });
  }
};
