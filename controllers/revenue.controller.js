// controllers/revenue.controller.js - COMPLETE UPDATED VERSION
// All functions updated with proper doctor commission handling

const Salary = require('../models/Salary');
const Invoice = require('../models/Invoice');
const Doctor = require('../models/Doctor');
const Patient = require('../models/Patient');
const Department = require('../models/Department');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

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
 * Calculate doctor commission based on doctor type and revenue percentage
 */
const calculateDoctorCommission = (doctor, revenue, serviceType = 'Appointment') => {
  if (!doctor) {
    return {
      commission: 0,
      commissionPercentage: 0,
      hospitalShare: revenue,
      isFullTime: false,
      doctorType: 'Unknown'
    };
  }

  const isFullTime = doctor.isFullTime || false;
  const revenuePercentage = doctor.revenuePercentage || (isFullTime ? 100 : 30);
  
  // For full-time doctors, commission is 0 (they get salary, not commission)
  const commission = isFullTime ? 0 : (revenue * revenuePercentage / 100);
  const hospitalShare = revenue - commission;

  return {
    commission,
    commissionPercentage: isFullTime ? 0 : revenuePercentage,
    hospitalShare,
    isFullTime,
    doctorType: isFullTime ? 'Full-time (Salary)' : 'Part-time (Commission)',
    revenueGenerated: revenue,
    doctorId: doctor._id,
    doctorName: `${doctor.firstName} ${doctor.lastName || ''}`.trim()
  };
};

/**
 * Enhanced revenue calculation with proper doctor share handling
 */
const calculateRevenueBifurcation = (invoices, doctorsMap) => {
  let totalRevenue = 0;
  let doctorEarnings = 0; // Total earnings by doctors (salary + commission)
  let hospitalRevenue = 0; // Revenue before salary expenses
  let totalCommission = 0; // Commission paid to part-time doctors
  let totalSalaryExpenses = 0; // Salary expenses for full-time doctors (estimated based on revenue)
  let partTimeCommission = 0;
  let fullTimeSalaryExpenses = 0;

  // Track by service type
  const procedureMetrics = {
    revenue: 0,
    commission: 0,
    hospitalShare: 0,
    doctorEarnings: 0
  };

  const labTestMetrics = {
    revenue: 0,
    commission: 0,
    hospitalShare: 0,
    doctorEarnings: 0
  };

  const appointmentMetrics = {
    revenue: 0,
    commission: 0,
    hospitalShare: 0,
    doctorEarnings: 0
  };

  const pharmacyMetrics = {
    revenue: 0,
    hospitalShare: 0,
    commission: 0,
    doctorEarnings: 0
  };

  const otherMetrics = {
    revenue: 0,
    hospitalShare: 0,
    commission: 0,
    doctorEarnings: 0
  };

  invoices.forEach(invoice => {
    const amount = invoice.total || 0;
    totalRevenue += amount;

    // Get doctor info from appointment
    const doctorId = invoice.appointment_id?.doctor_id;
    const doctor = doctorId ? doctorsMap.get(doctorId.toString()) : null;
    
    // Calculate commission based on doctor type
    const commissionInfo = calculateDoctorCommission(doctor, amount, invoice.invoice_type);
    
    // Track doctor earnings (salary for full-time, commission for part-time)
    if (commissionInfo.isFullTime) {
      // Full-time doctor: Add to salary expenses (estimated based on revenue)
      fullTimeSalaryExpenses += amount; // This represents revenue generated by full-time doctors
      doctorEarnings += amount; // Their "earnings" for revenue tracking
      totalSalaryExpenses += amount; // For expense calculation (estimated)
    } else {
      // Part-time doctor: Add commission
      partTimeCommission += commissionInfo.commission;
      totalCommission += commissionInfo.commission;
      doctorEarnings += commissionInfo.commission;
    }

    // Hospital share is always amount minus commission (for part-time)
    // For full-time, hospital share is full amount (since they're salaried)
    const invoiceHospitalShare = commissionInfo.hospitalShare;
    hospitalRevenue += invoiceHospitalShare;

    // Track by service type
    switch (invoice.invoice_type) {
      case 'Procedure':
        procedureMetrics.revenue += amount;
        procedureMetrics.commission += commissionInfo.commission;
        procedureMetrics.hospitalShare += invoiceHospitalShare;
        procedureMetrics.doctorEarnings += commissionInfo.isFullTime ? amount : commissionInfo.commission;
        break;
      case 'Lab Test':
        labTestMetrics.revenue += amount;
        labTestMetrics.commission += commissionInfo.commission;
        labTestMetrics.hospitalShare += invoiceHospitalShare;
        labTestMetrics.doctorEarnings += commissionInfo.isFullTime ? amount : commissionInfo.commission;
        break;
      case 'Appointment':
        appointmentMetrics.revenue += amount;
        appointmentMetrics.commission += commissionInfo.commission;
        appointmentMetrics.hospitalShare += invoiceHospitalShare;
        appointmentMetrics.doctorEarnings += commissionInfo.isFullTime ? amount : commissionInfo.commission;
        break;
      case 'Pharmacy':
        pharmacyMetrics.revenue += amount;
        pharmacyMetrics.hospitalShare += amount; // Pharmacy revenue is 100% hospital
        pharmacyMetrics.commission += 0;
        pharmacyMetrics.doctorEarnings += 0;
        break;
      default:
        otherMetrics.revenue += amount;
        otherMetrics.hospitalShare += invoiceHospitalShare;
        otherMetrics.commission += commissionInfo.commission;
        otherMetrics.doctorEarnings += commissionInfo.isFullTime ? amount : commissionInfo.commission;
        break;
    }
  });

  // Calculate net hospital revenue (hospital revenue minus salary expenses)
  const netHospitalRevenue = hospitalRevenue - fullTimeSalaryExpenses;

  return {
    totalRevenue,
    doctorEarnings,
    hospitalRevenue,
    totalCommission,
    totalSalaryExpenses,
    partTimeCommission,
    fullTimeSalaryExpenses,
    netHospitalRevenue,
    profitMargin: totalRevenue > 0 ? (netHospitalRevenue / totalRevenue) * 100 : 0,
    
    procedureMetrics,
    labTestMetrics,
    appointmentMetrics,
    pharmacyMetrics,
    otherMetrics
  };
};

/**
 * Get all doctors as a map for efficient lookup
 */
const getDoctorsMap = async () => {
  const doctors = await Doctor.find({});
  const doctorsMap = new Map();
  doctors.forEach(doc => {
    doctorsMap.set(doc._id.toString(), doc);
  });
  return doctorsMap;
};

/**
 * Get procedure details with commission breakdown
 */
async function getProcedureDetails(startDate, endDate, doctorsMap) {
  const procedureMatch = { invoice_type: 'Procedure' };
  if (startDate && endDate) {
    procedureMatch.$or = [
      { created_at: { $gte: startDate, $lte: endDate } },
      { createdAt: { $gte: startDate, $lte: endDate } }
    ];
  }

  const procedureDetails = await Invoice.aggregate([
    { $match: procedureMatch },
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
      $group: {
        _id: '$procedure_items.procedure_code',
        procedureCode: { $first: '$procedure_items.procedure_code' },
        procedureName: { $first: '$procedure_items.procedure_name' },
        totalRevenue: { $sum: '$procedure_items.total_price' },
        count: { $sum: '$procedure_items.quantity' },
        averagePrice: { $avg: '$procedure_items.unit_price' },
        doctors: { $push: '$doctor' }
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  // Calculate commission for each procedure
  return procedureDetails.map(proc => {
    let doctorEarnings = 0;
    let hospitalShare = proc.totalRevenue;

    if (proc.doctors && proc.doctors.length > 0) {
      const uniqueDoctors = new Map();
      proc.doctors.forEach(doc => {
        if (doc && doc._id) {
          uniqueDoctors.set(doc._id.toString(), doc);
        }
      });

      uniqueDoctors.forEach(doc => {
        const doctor = doctorsMap.get(doc._id.toString());
        if (doctor && !doctor.isFullTime) {
          const percentage = doctor.revenuePercentage || 30;
          const doctorRevenue = proc.totalRevenue / uniqueDoctors.size;
          const commission = doctorRevenue * percentage / 100;
          doctorEarnings += commission;
        }
      });

      hospitalShare = proc.totalRevenue - doctorEarnings;
    }

    return {
      code: proc.procedureCode,
      name: proc.procedureName,
      revenue: proc.totalRevenue,
      count: proc.count,
      averagePrice: proc.averagePrice,
      doctorEarnings,
      hospitalShare
    };
  });
}

/**
 * Get lab test details with commission breakdown
 */
async function getLabTestDetails(startDate, endDate, doctorsMap) {
  const labTestMatch = { invoice_type: 'Lab Test' };
  if (startDate && endDate) {
    labTestMatch.$or = [
      { created_at: { $gte: startDate, $lte: endDate } },
      { createdAt: { $gte: startDate, $lte: endDate } }
    ];
  }

  const labTestDetails = await Invoice.aggregate([
    { $match: labTestMatch },
    { $unwind: '$lab_test_items' },
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
      $group: {
        _id: '$lab_test_items.lab_test_code',
        labTestCode: { $first: '$lab_test_items.lab_test_code' },
        labTestName: { $first: '$lab_test_items.lab_test_name' },
        totalRevenue: { $sum: '$lab_test_items.total_price' },
        count: { $sum: '$lab_test_items.quantity' },
        averagePrice: { $avg: '$lab_test_items.unit_price' },
        doctors: { $push: '$doctor' }
      }
    },
    { $sort: { totalRevenue: -1 } }
  ]);

  // Calculate commission for each lab test
  return labTestDetails.map(test => {
    let doctorEarnings = 0;
    let hospitalShare = test.totalRevenue;

    if (test.doctors && test.doctors.length > 0) {
      const uniqueDoctors = new Map();
      test.doctors.forEach(doc => {
        if (doc && doc._id) {
          uniqueDoctors.set(doc._id.toString(), doc);
        }
      });

      uniqueDoctors.forEach(doc => {
        const doctor = doctorsMap.get(doc._id.toString());
        if (doctor && !doctor.isFullTime) {
          const percentage = doctor.revenuePercentage || 30;
          const doctorRevenue = test.totalRevenue / uniqueDoctors.size;
          const commission = doctorRevenue * percentage / 100;
          doctorEarnings += commission;
        }
      });

      hospitalShare = test.totalRevenue - doctorEarnings;
    }

    return {
      code: test.labTestCode,
      name: test.labTestName,
      revenue: test.totalRevenue,
      count: test.count,
      averagePrice: test.averagePrice,
      doctorEarnings,
      hospitalShare
    };
  });
}

/**
 * Calculate hospital revenue with dual date field support
 */
exports.calculateHospitalRevenue = async (req, res) => {
  try {
    const { pipeline, period } = buildInvoicePipeline(req.query, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

    // Ensure we have doctor_info
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
        department_id: '$doctor_info.department',
        doctor_isFullTime: '$doctor_info.isFullTime',
        doctor_revenuePercentage: '$doctor_info.revenuePercentage'
      }
    });

    const invoices = await Invoice.aggregate(pipeline);

    // Get doctors map for commission calculation
    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    // Calculate revenue bifurcation with proper doctor shares
    const bifurcation = calculateRevenueBifurcation(invoices, doctorsMap);

    // Stats accumulators
    let totalRevenue = 0;
    let appointmentRevenue = 0;
    let pharmacyRevenue = 0;
    let procedureRevenue = 0;
    let labTestRevenue = 0;
    let otherRevenue = 0;

    let totalInvoices = 0;
    let appointmentCount = 0;
    let pharmacyCount = 0;
    let procedureCount = 0;
    let labTestCount = 0;

    let paidAmount = 0;
    let pendingAmount = 0;

    const uniquePatients = new Set();
    const uniqueDoctors = new Set();

    const doctorRevenue = {};
    const doctorEarningsMap = {};
    const patientRevenue = {};
    const departmentRevenue = {};

    const procedureRevenueByDoctor = {};
    const labTestRevenueByDoctor = {};
    const procedureRevenueByDepartment = {};
    const labTestRevenueByDepartment = {};

    const paymentMethods = {};
    const dailyStats = {};

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
        case 'Lab Test':
          labTestRevenue += amount;
          labTestCount += 1;
          break;
        default:
          otherRevenue += amount;
      }

      // Get doctor info and calculate earnings
      const doctorId = inv.doctor_id ? inv.doctor_id.toString() : null;
      const doctor = doctorId ? doctorsMap.get(doctorId) : null;
      
      if (doctorId) {
        uniqueDoctors.add(doctorId);
        
        doctorRevenue[doctorId] = (doctorRevenue[doctorId] || 0) + amount;
        
        const commissionInfo = calculateDoctorCommission(doctor, amount, inv.invoice_type);
        doctorEarningsMap[doctorId] = (doctorEarningsMap[doctorId] || 0) + commissionInfo.commission;

        if (inv.invoice_type === 'Procedure') {
          procedureRevenueByDoctor[doctorId] = (procedureRevenueByDoctor[doctorId] || 0) + amount;
        }
        if (inv.invoice_type === 'Lab Test') {
          labTestRevenueByDoctor[doctorId] = (labTestRevenueByDoctor[doctorId] || 0) + amount;
        }

        const deptId = inv.department_id ? inv.department_id.toString() : 'Unknown';
        departmentRevenue[deptId] = (departmentRevenue[deptId] || 0) + amount;
        
        if (inv.invoice_type === 'Procedure') {
          procedureRevenueByDepartment[deptId] = (procedureRevenueByDepartment[deptId] || 0) + amount;
        }
        if (inv.invoice_type === 'Lab Test') {
          labTestRevenueByDepartment[deptId] = (labTestRevenueByDepartment[deptId] || 0) + amount;
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

      // Daily stats
      const dateValue = inv.computed_date || inv.created_at || inv.createdAt;
      const dateKey = new Date(dateValue).toISOString().split('T')[0];
      
      if (!dailyStats[dateKey]) {
        dailyStats[dateKey] = {
          date: dateKey,
          revenue: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0,
          labTests: 0,
          procedureRevenue: 0,
          labTestRevenue: 0,
          appointmentRevenue: 0,
          pharmacyRevenue: 0,
          doctorEarnings: 0,
          hospitalShare: 0
        };
      }
      dailyStats[dateKey].revenue += amount;
      
      const commissionInfo = calculateDoctorCommission(doctor, amount, inv.invoice_type);
      dailyStats[dateKey].doctorEarnings += commissionInfo.commission;
      dailyStats[dateKey].hospitalShare += commissionInfo.hospitalShare;
      
      if (inv.invoice_type === 'Appointment') {
        dailyStats[dateKey].appointments += 1;
        dailyStats[dateKey].appointmentRevenue += amount;
      } else if (inv.invoice_type === 'Pharmacy') {
        dailyStats[dateKey].pharmacy += 1;
        dailyStats[dateKey].pharmacyRevenue += amount;
      } else if (inv.invoice_type === 'Procedure') {
        dailyStats[dateKey].procedures += 1;
        dailyStats[dateKey].procedureRevenue += amount;
      } else if (inv.invoice_type === 'Lab Test') {
        dailyStats[dateKey].labTests += 1;
        dailyStats[dateKey].labTestRevenue += amount;
      }

      // Payment methods
      if (Array.isArray(inv.payment_history) && inv.payment_history.length) {
        inv.payment_history.forEach((p) => {
          const method = p.method || 'Unknown';
          paymentMethods[method] = (paymentMethods[method] || 0) + (p.amount || 0);
        });
      }
    });

    // Get detailed procedure and lab test breakdowns
    const procedureDetails = await getProcedureDetails(period.start, period.end, doctorsMap);
    const labTestDetails = await getLabTestDetails(period.start, period.end, doctorsMap);

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

    const actualSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - actualSalaryExpenses;

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
      const earnings = doctorEarningsMap[String(id)] || 0;
      const procedureRev = procedureRevenueByDoctor[String(id)] || 0;
      const labTestRev = labTestRevenueByDoctor[String(id)] || 0;
      
      return {
        doctorId: String(id),
        name: d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown',
        revenueGenerated: revenue,
        earnings,
        procedureRevenue: procedureRev,
        labTestRevenue: labTestRev,
        isFullTime: d?.isFullTime || false,
        revenuePercentage: d?.revenuePercentage || (d?.isFullTime ? 100 : 30),
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

    // Get department names
    const departments = await Department.find({});
    const deptMap = new Map(departments.map(d => [d._id.toString(), d.name]));

    // Format procedure by doctor with commission info
    const procedureByDoctorArray = Object.entries(procedureRevenueByDoctor).map(([docId, rev]) => {
      const doc = doctorsMap.get(docId);
      const commissionInfo = calculateDoctorCommission(doc, rev, 'Procedure');
      return {
        doctorId: docId,
        doctorName: doc ? `${doc.firstName} ${doc.lastName || ''}`.trim() : 'Unknown',
        revenue: rev,
        earnings: commissionInfo.commission,
        commission: commissionInfo.commission,
        hospitalShare: commissionInfo.hospitalShare,
        isFullTime: doc?.isFullTime || false,
        percentage: procedureRevenue > 0 ? (rev / procedureRevenue) * 100 : 0
      };
    }).sort((a, b) => b.revenue - a.revenue);

    const labTestByDoctorArray = Object.entries(labTestRevenueByDoctor).map(([docId, rev]) => {
      const doc = doctorsMap.get(docId);
      const commissionInfo = calculateDoctorCommission(doc, rev, 'Lab Test');
      return {
        doctorId: docId,
        doctorName: doc ? `${doc.firstName} ${doc.lastName || ''}`.trim() : 'Unknown',
        revenue: rev,
        earnings: commissionInfo.commission,
        commission: commissionInfo.commission,
        hospitalShare: commissionInfo.hospitalShare,
        isFullTime: doc?.isFullTime || false,
        percentage: labTestRevenue > 0 ? (rev / labTestRevenue) * 100 : 0
      };
    }).sort((a, b) => b.revenue - a.revenue);

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
        labTestRevenue,
        otherRevenue,
        actualSalaryExpenses,
        estimatedSalaryExpenses: bifurcation.fullTimeSalaryExpenses,
        netRevenue,
        
        doctorEarnings: bifurcation.doctorEarnings,
        hospitalRevenue: bifurcation.hospitalRevenue,
        totalCommission: bifurcation.totalCommission,
        totalSalaryExpenses: bifurcation.totalSalaryExpenses,
        actualSalaryExpenses,
        netHospitalRevenue: bifurcation.netHospitalRevenue,
        actualNetHospitalRevenue: bifurcation.hospitalRevenue - actualSalaryExpenses,
        
        collectionRate: totalRevenue > 0 ? (paidAmount / totalRevenue) * 100 : 0,
        pendingRate: totalRevenue > 0 ? (pendingAmount / totalRevenue) * 100 : 0,
        
        procedureMetrics: bifurcation.procedureMetrics,
        labTestMetrics: bifurcation.labTestMetrics,
        appointmentMetrics: bifurcation.appointmentMetrics,
        pharmacyMetrics: bifurcation.pharmacyMetrics,
        otherMetrics: bifurcation.otherMetrics
      },
      counts: {
        totalInvoices,
        appointments: appointmentCount,
        pharmacySales: pharmacyCount,
        procedures: procedureCount,
        labTests: labTestCount,
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
            average: appointmentCount > 0 ? Number((appointmentRevenue / appointmentCount).toFixed(2)) : 0,
            doctorEarnings: bifurcation.appointmentMetrics.doctorEarnings,
            hospitalShare: bifurcation.appointmentMetrics.hospitalShare,
            commission: bifurcation.appointmentMetrics.commission
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? Number(((pharmacyRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: pharmacyCount,
            average: pharmacyCount > 0 ? Number((pharmacyRevenue / pharmacyCount).toFixed(2)) : 0,
            hospitalShare: pharmacyRevenue,
            doctorEarnings: 0,
            commission: 0
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? Number(((procedureRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: procedureCount,
            average: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0,
            doctorEarnings: bifurcation.procedureMetrics.doctorEarnings,
            commission: bifurcation.procedureMetrics.commission,
            hospitalShare: bifurcation.procedureMetrics.hospitalShare,
            byProcedure: procedureDetails.map(p => ({
              code: p.code,
              name: p.name,
              revenue: p.revenue,
              count: p.count,
              averagePrice: p.averagePrice,
              percentage: procedureRevenue > 0 ? (p.revenue / procedureRevenue) * 100 : 0,
              doctorEarnings: p.doctorEarnings || 0,
              hospitalShare: p.hospitalShare || 0
            })),
            byDoctor: procedureByDoctorArray,
            byDepartment: Object.entries(procedureRevenueByDepartment).map(([deptId, rev]) => ({
              departmentId: deptId,
              departmentName: deptMap.get(deptId) || (deptId === 'Unknown' ? 'Unknown' : 'Unknown Department'),
              revenue: rev,
              percentage: procedureRevenue > 0 ? (rev / procedureRevenue) * 100 : 0
            })).sort((a, b) => b.revenue - a.revenue)
          },
          labTests: {
            amount: labTestRevenue,
            percentage: totalRevenue > 0 ? Number(((labTestRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: labTestCount,
            average: labTestCount > 0 ? Number((labTestRevenue / labTestCount).toFixed(2)) : 0,
            doctorEarnings: bifurcation.labTestMetrics.doctorEarnings,
            commission: bifurcation.labTestMetrics.commission,
            hospitalShare: bifurcation.labTestMetrics.hospitalShare,
            byLabTest: labTestDetails.map(t => ({
              code: t.code,
              name: t.name,
              revenue: t.revenue,
              count: t.count,
              averagePrice: t.averagePrice,
              percentage: labTestRevenue > 0 ? (t.revenue / labTestRevenue) * 100 : 0,
              doctorEarnings: t.doctorEarnings || 0,
              hospitalShare: t.hospitalShare || 0
            })),
            byDoctor: labTestByDoctorArray,
            byDepartment: Object.entries(labTestRevenueByDepartment).map(([deptId, rev]) => ({
              departmentId: deptId,
              departmentName: deptMap.get(deptId) || (deptId === 'Unknown' ? 'Unknown' : 'Unknown Department'),
              revenue: rev,
              percentage: labTestRevenue > 0 ? (rev / labTestRevenue) * 100 : 0
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
            departmentName: deptMap.get(departmentId) || (departmentId === 'Unknown' ? 'Unknown' : 'Unknown Department'),
            amount,
            percentage: totalRevenue > 0 ? Number(((amount / totalRevenue) * 100).toFixed(2)) : 0
          }))
          .sort((a, b) => b.amount - a.amount),
        byPaymentMethod: paymentMethodBreakdown,
        daily: dailyBreakdown
      },
      topPerformers: {
        doctors: topDoctors,
        procedures: procedureDetails.slice(0, 5).map(p => ({
          code: p.code,
          name: p.name,
          revenue: p.revenue,
          count: p.count,
          averagePrice: p.averagePrice
        })),
        labTests: labTestDetails.slice(0, 5).map(t => ({
          code: t.code,
          name: t.name,
          revenue: t.revenue,
          count: t.count,
          averagePrice: t.averagePrice
        }))
      },
      metrics: {
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0,
        expenseRatio: totalRevenue > 0 ? Number(((actualSalaryExpenses / totalRevenue) * 100).toFixed(2)) : 0,
        averageInvoiceValue: totalInvoices > 0 ? Number((totalRevenue / totalInvoices).toFixed(2)) : 0,
        averageDailyRevenue: dailyBreakdown.length > 0 ? Number((totalRevenue / dailyBreakdown.length).toFixed(2)) : 0,
        averageProcedureValue: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0,
        averageLabTestValue: labTestCount > 0 ? Number((labTestRevenue / labTestCount).toFixed(2)) : 0,
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
 * Get daily revenue report with proper doctor commission
 */
exports.getDailyRevenueReport = async (req, res) => {
  try {
    const { date, doctorId, departmentId, invoiceType, paymentMethod } = req.query;

    const dateStr = date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    
    const istDate = new Date(`${dateStr}T00:00:00.000+05:30`);
    const istEndDate = new Date(`${dateStr}T23:59:59.999+05:30`);
    
    const startOfDayUTC = new Date(istDate.toISOString());
    const endOfDayUTC = new Date(istEndDate.toISOString());

    const matchStage = {
      $or: [
        { created_at: { $gte: startOfDayUTC, $lte: endOfDayUTC } },
        { createdAt: { $gte: startOfDayUTC, $lte: endOfDayUTC } }
      ]
    };

    if (invoiceType) {
      matchStage.invoice_type = invoiceType;
    }

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

    // Get doctors map for commission calculation
    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    let totalRevenue = 0;
    let totalPaid = 0;
    let totalPending = 0;
    let totalDoctorEarnings = 0;
    let totalHospitalShare = 0;
    
    const revenueByType = {
      Appointment: 0,
      Pharmacy: 0,
      Procedure: 0,
      'Lab Test': 0,
      Mixed: 0,
      Other: 0
    };

    const countByType = {
      Appointment: 0,
      Pharmacy: 0,
      Procedure: 0,
      'Lab Test': 0,
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
    const hourlyDataIST = Array(24).fill(0).map(() => ({ count: 0, revenue: 0, doctorEarnings: 0, hospitalShare: 0 }));

    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const paid = invoice.amount_paid || 0;
      const pending = invoice.balance_due || 0;
      
      if (!['Draft', 'Cancelled'].includes(invoice.status)) {
        totalRevenue += amount;
        totalPaid += paid;
        totalPending += pending;

        const doctor = invoice.appointment_id?.doctor_id;
        const commissionInfo = calculateDoctorCommission(doctor, amount, invoice.invoice_type);
        
        totalDoctorEarnings += commissionInfo.commission;
        totalHospitalShare += commissionInfo.hospitalShare;

        const type = invoice.invoice_type || 'Other';
        if (revenueByType.hasOwnProperty(type)) {
          revenueByType[type] += amount;
          countByType[type] += 1;
        } else {
          revenueByType.Other += amount;
          countByType.Other += 1;
        }

        if (revenueByStatus.hasOwnProperty(invoice.status)) {
          revenueByStatus[invoice.status] += amount;
        }

        if (doctor) {
          const doctorId = doctor._id.toString();
          const doctorName = `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim() || 'Unknown';
          
          if (!doctorRevenue[doctorId]) {
            doctorRevenue[doctorId] = {
              doctorId,
              name: doctorName,
              revenue: 0,
              earnings: 0,
              commission: 0,
              hospitalShare: 0,
              invoiceCount: 0,
              isFullTime: doctor.isFullTime || false,
              specialization: doctor.specialization || 'General'
            };
          }
          
          doctorRevenue[doctorId].revenue += amount;
          doctorRevenue[doctorId].earnings += commissionInfo.commission;
          doctorRevenue[doctorId].commission += commissionInfo.commission;
          doctorRevenue[doctorId].hospitalShare += commissionInfo.hospitalShare;
          doctorRevenue[doctorId].invoiceCount += 1;
        }

        if (invoice.payment_history && invoice.payment_history.length > 0) {
          invoice.payment_history.forEach(payment => {
            const method = payment.method || 'Unknown';
            paymentMethods[method] = (paymentMethods[method] || 0) + (payment.amount || 0);
          });
        }

        const dateField = invoice.created_at || invoice.createdAt;
        const istHour = new Date(dateField).toLocaleString('en-US', { 
          timeZone: 'Asia/Kolkata',
          hour: 'numeric',
          hour12: false 
        });
        const hour = parseInt(istHour);
        
        hourlyDataIST[hour].count += 1;
        hourlyDataIST[hour].revenue += amount;
        hourlyDataIST[hour].doctorEarnings += commissionInfo.commission;
        hourlyDataIST[hour].hospitalShare += commissionInfo.hospitalShare;
      }
    });

    const doctorBreakdown = Object.values(doctorRevenue).sort((a, b) => b.revenue - a.revenue);

    const totalPayments = Object.values(paymentMethods).reduce((a, b) => a + b, 0);
    const paymentMethodBreakdown = Object.entries(paymentMethods).map(([method, amount]) => ({
      method,
      amount,
      percentage: totalPayments > 0 ? Number(((amount / totalPayments) * 100).toFixed(2)) : 0
    })).sort((a, b) => b.amount - a.amount);

    let busiestHour = 0;
    let maxRevenue = 0;
    hourlyDataIST.forEach((data, hour) => {
      if (data.revenue > maxRevenue) {
        maxRevenue = data.revenue;
        busiestHour = hour;
      }
    });

    const hourlyBreakdown = hourlyDataIST.map((data, hour) => ({
      hour: `${String(hour).padStart(2, '0')}:00 IST`,
      count: data.count,
      revenue: Number(data.revenue.toFixed(2)),
      doctorEarnings: Number(data.doctorEarnings.toFixed(2)),
      hospitalShare: Number(data.hospitalShare.toFixed(2)),
      percentage: totalRevenue > 0 ? Number(((data.revenue / totalRevenue) * 100).toFixed(2)) : 0
    }));

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
        totalDoctorEarnings: Number(totalDoctorEarnings.toFixed(2)),
        totalHospitalShare: Number(totalHospitalShare.toFixed(2)),
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
          earnings: Number(doc.earnings.toFixed(2)),
          commission: Number(doc.commission.toFixed(2)),
          hospitalShare: Number(doc.hospitalShare.toFixed(2)),
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
        const doctor = inv.appointment_id?.doctor_id;
        const commissionInfo = calculateDoctorCommission(doctor, inv.total || 0, inv.invoice_type);
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
          doctor: doctor ?
            `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim() :
            'Not assigned',
          doctorType: doctor?.isFullTime ? 'Full-time' : 'Part-time',
          amount: inv.total,
          paid: inv.amount_paid,
          commission: commissionInfo.commission,
          hospitalShare: commissionInfo.hospitalShare,
          status: inv.status,
          timeIST: istTime,
          timeUTC: dateField
        };
      })
    };

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
    console.error('Error in getDailyRevenueReport:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate daily revenue report',
      details: error.message 
    });
  }
};

/**
 * Get monthly revenue report with proper doctor commission
 */
exports.getMonthlyRevenueReport = async (req, res) => {
  try {
    const { year, month, doctorId, department, invoiceType, paymentMethod, patientType } = req.query;

    const targetYear = parseInt(year, 10) || new Date().getFullYear();
    const targetMonth = parseInt(month, 10) || new Date().getMonth() + 1;

    const startDate = new Date(Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999));

    const query = {
      $or: [
        { created_at: { $gte: startDate, $lte: endDate } },
        { createdAt: { $gte: startDate, $lte: endDate } }
      ]
    };

    if (invoiceType && invoiceType !== 'all') query.invoice_type = invoiceType;
    if (paymentMethod && paymentMethod !== 'all') query['payment_history.method'] = paymentMethod;

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

    // Apply additional filters
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

    // Get doctors map for commission calculation
    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    let totalRevenue = 0;
    let appointmentRevenue = 0;
    let pharmacyRevenue = 0;
    let procedureRevenue = 0;
    let labTestRevenue = 0;
    let otherRevenue = 0;

    let appointmentCount = 0;
    let pharmacyCount = 0;
    let procedureCount = 0;
    let labTestCount = 0;

    let totalDoctorEarnings = 0;
    let totalHospitalShare = 0;

    const dailyBreakdown = {};
    const weeklyBreakdown = {};
    const doctorBreakdown = {};
    const patientBreakdown = {};
    const paymentMethodBreakdown = {};

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      
      let dateField;
      if (inv.created_at) {
        dateField = inv.created_at;
      } else if (inv.createdAt) {
        dateField = inv.createdAt;
      } else {
        dateField = new Date();
      }

      const dateObj = dateField instanceof Date ? dateField : new Date(dateField);
      
      if (isNaN(dateObj.getTime())) {
        console.warn('Invalid date found for invoice:', inv.invoice_number);
        return;
      }

      const day = dateObj.getDate();
      const week = Math.ceil(day / 7);

      const doctor = inv.appointment_id?.doctor_id;
      const commissionInfo = calculateDoctorCommission(doctor, amount, inv.invoice_type);

      totalRevenue += amount;
      totalDoctorEarnings += commissionInfo.commission;
      totalHospitalShare += commissionInfo.hospitalShare;

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
        case 'Lab Test':
          labTestRevenue += amount;
          labTestCount += 1;
          break;
        default:
          otherRevenue += amount;
      }

      const dateKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = {
          date: dateKey,
          revenue: 0,
          doctorEarnings: 0,
          hospitalShare: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0,
          labTests: 0
        };
      }
      dailyBreakdown[day].revenue += amount;
      dailyBreakdown[day].doctorEarnings += commissionInfo.commission;
      dailyBreakdown[day].hospitalShare += commissionInfo.hospitalShare;
      
      if (inv.invoice_type === 'Appointment') dailyBreakdown[day].appointments += 1;
      if (inv.invoice_type === 'Pharmacy') dailyBreakdown[day].pharmacy += 1;
      if (inv.invoice_type === 'Procedure') dailyBreakdown[day].procedures += 1;
      if (inv.invoice_type === 'Lab Test') dailyBreakdown[day].labTests += 1;

      if (!weeklyBreakdown[week]) {
        weeklyBreakdown[week] = {
          week,
          startDay: (week - 1) * 7 + 1,
          endDay: Math.min(week * 7, new Date(targetYear, targetMonth, 0).getDate()),
          revenue: 0,
          doctorEarnings: 0,
          hospitalShare: 0,
          appointments: 0,
          pharmacy: 0,
          procedures: 0,
          labTests: 0
        };
      }
      weeklyBreakdown[week].revenue += amount;
      weeklyBreakdown[week].doctorEarnings += commissionInfo.commission;
      weeklyBreakdown[week].hospitalShare += commissionInfo.hospitalShare;
      
      if (inv.invoice_type === 'Appointment') weeklyBreakdown[week].appointments += 1;
      if (inv.invoice_type === 'Pharmacy') weeklyBreakdown[week].pharmacy += 1;
      if (inv.invoice_type === 'Procedure') weeklyBreakdown[week].procedures += 1;
      if (inv.invoice_type === 'Lab Test') weeklyBreakdown[week].labTests += 1;

      const docId = inv.appointment_id?.doctor_id?._id?.toString();
      if (docId) {
        const doctor = inv.appointment_id.doctor_id;
        
        if (!doctorBreakdown[docId]) {
          doctorBreakdown[docId] = {
            doctorId: docId,
            name: doctor ? `${doctor.firstName} ${doctor.lastName || ''}`.trim() : 'Unknown',
            revenue: 0,
            earnings: 0,
            commission: 0,
            hospitalShare: 0,
            appointments: 0,
            isFullTime: doctor?.isFullTime || false,
            department: doctor?.department || 'Unknown',
            specialization: doctor?.specialization || 'N/A'
          };
        }
        doctorBreakdown[docId].revenue += amount;
        doctorBreakdown[docId].earnings += commissionInfo.commission;
        doctorBreakdown[docId].commission += commissionInfo.commission;
        doctorBreakdown[docId].hospitalShare += commissionInfo.hospitalShare;
        if (inv.invoice_type === 'Appointment') doctorBreakdown[docId].appointments += 1;
      }

      if (inv.patient_id) {
        const pId = inv.patient_id._id.toString();
        patientBreakdown[pId] = (patientBreakdown[pId] || 0) + amount;
      }

      if (Array.isArray(inv.payment_history) && inv.payment_history.length) {
        inv.payment_history.forEach((p) => {
          const method = p.method || 'Unknown';
          paymentMethodBreakdown[method] = (paymentMethodBreakdown[method] || 0) + (p.amount || 0);
        });
      }
    });

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
    
    const actualSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    const netRevenue = totalRevenue - actualSalaryExpenses;
    const businessDays = Object.keys(dailyBreakdown).length;

    let highestRevenueDay = { revenue: 0, date: '' };
    Object.values(dailyBreakdown).forEach((d) => {
      if (d.revenue > highestRevenueDay.revenue) {
        highestRevenueDay = d;
      }
    });

    const doctorBreakdownArray = Object.values(doctorBreakdown).sort((a, b) => b.revenue - a.revenue);

    const topPatientIds = Object.entries(patientBreakdown)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([id]) => toObjectId(id))
      .filter(Boolean);

    const patientDocs = topPatientIds.length
      ? await Patient.find({ _id: { $in: topPatientIds } }).select('first_name last_name patient_type')
      : [];
    const patientMap = new Map(patientDocs.map((p) => [String(p._id), p]));

    const patientVisits = {};
    const patientLastVisit = {};
    invoices.forEach((inv) => {
      if (!inv.patient_id) return;
      const pId = String(inv.patient_id._id);
      patientVisits[pId] = (patientVisits[pId] || 0) + 1;
      
      let dateField;
      if (inv.created_at) {
        dateField = inv.created_at;
      } else if (inv.createdAt) {
        dateField = inv.createdAt;
      } else {
        return;
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
        labTestRevenue,
        otherRevenue,
        totalDoctorEarnings,
        totalHospitalShare,
        actualSalaryExpenses,
        netRevenue,
        profitMargin: totalRevenue > 0 ? Number(((netRevenue / totalRevenue) * 100).toFixed(2)) : 0,
        expenseRatio: totalRevenue > 0 ? Number(((actualSalaryExpenses / totalRevenue) * 100).toFixed(2)) : 0,
        collectionRate: totalRevenue > 0 ? Number(((totalCollected / totalRevenue) * 100).toFixed(2)) : 0
      },
      counts: {
        totalInvoices: invoices.length,
        appointments: appointmentCount,
        pharmacySales: pharmacyCount,
        procedures: procedureCount,
        labTests: labTestCount,
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
            average: appointmentCount > 0 ? Number((appointmentRevenue / appointmentCount).toFixed(2)) : 0,
            doctorEarnings: appointmentRevenue * 0.3, // Estimate
            hospitalShare: appointmentRevenue * 0.7
          },
          pharmacy: {
            amount: pharmacyRevenue,
            percentage: totalRevenue > 0 ? Number(((pharmacyRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: pharmacyCount,
            average: pharmacyCount > 0 ? Number((pharmacyRevenue / pharmacyCount).toFixed(2)) : 0,
            hospitalShare: pharmacyRevenue
          },
          procedures: {
            amount: procedureRevenue,
            percentage: totalRevenue > 0 ? Number(((procedureRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: procedureCount,
            average: procedureCount > 0 ? Number((procedureRevenue / procedureCount).toFixed(2)) : 0,
            doctorEarnings: procedureRevenue * 0.3, // Estimate
            hospitalShare: procedureRevenue * 0.7
          },
          labTests: {
            amount: labTestRevenue,
            percentage: totalRevenue > 0 ? Number(((labTestRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            count: labTestCount,
            average: labTestCount > 0 ? Number((labTestRevenue / labTestCount).toFixed(2)) : 0,
            doctorEarnings: labTestRevenue * 0.3, // Estimate
            hospitalShare: labTestRevenue * 0.7
          },
          other: {
            amount: otherRevenue,
            percentage: totalRevenue > 0 ? Number(((otherRevenue / totalRevenue) * 100).toFixed(2)) : 0,
            hospitalShare: otherRevenue
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
          procedures: dailyBreakdownArray.map((d) => d.procedures),
          labTests: dailyBreakdownArray.map((d) => d.labTests)
        }
      }
    });
  } catch (error) {
    console.error('Error getting monthly revenue report:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get doctor revenue report with proper commission
 */
exports.getDoctorRevenue = async (req, res) => {
  try {
    const { doctorId, startDate, endDate, invoiceType } = req.query;

    const doctorObjId = toObjectId(doctorId);
    if (!doctorObjId) return res.status(400).json({ error: 'Invalid doctorId' });

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

    const match = { 
      $or: [
        { created_at: { $gte: start, $lte: end } },
        { createdAt: { $gte: start, $lte: end } }
      ]
    };
    if (invoiceType && invoiceType !== 'all') match.invoice_type = invoiceType;
    pipeline.push({ $match: match });

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

    pipeline.push({
      $addFields: {
        computed_date: { $ifNull: ['$created_at', '$createdAt'] }
      }
    });

    const invoices = await Invoice.aggregate(pipeline);

    const doctor = await Doctor.findById(doctorObjId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    let totalRevenue = 0;
    let totalCommission = 0;
    let totalHospitalShare = 0;
    let appointmentCount = 0;
    let procedureCount = 0;
    let labTestCount = 0;
    let pharmacyCount = 0;

    const dailyRevenue = {};
    const patientBreakdown = {};
    const serviceBreakdown = {};

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      const commissionInfo = calculateDoctorCommission(doctor, amount, inv.invoice_type);
      
      totalRevenue += amount;
      totalCommission += commissionInfo.commission;
      totalHospitalShare += commissionInfo.hospitalShare;

      if (inv.invoice_type === 'Appointment') appointmentCount += 1;
      if (inv.invoice_type === 'Procedure') procedureCount += 1;
      if (inv.invoice_type === 'Lab Test') labTestCount += 1;
      if (inv.invoice_type === 'Pharmacy') pharmacyCount += 1;

      const dateKey = new Date(inv.computed_date || inv.created_at || inv.createdAt).toISOString().split('T')[0];
      if (!dailyRevenue[dateKey]) {
        dailyRevenue[dateKey] = { revenue: 0, commission: 0, hospitalShare: 0 };
      }
      dailyRevenue[dateKey].revenue += amount;
      dailyRevenue[dateKey].commission += commissionInfo.commission;
      dailyRevenue[dateKey].hospitalShare += commissionInfo.hospitalShare;

      if (inv.patient_id) {
        const pId = String(inv.patient_id);
        if (!patientBreakdown[pId]) {
          patientBreakdown[pId] = {
            id: pId,
            name: inv.patient_info
              ? `${inv.patient_info.first_name} ${inv.patient_info.last_name || ''}`.trim()
              : 'Unknown',
            revenue: 0,
            commission: 0,
            hospitalShare: 0,
            visits: 0
          };
        }
        patientBreakdown[pId].revenue += amount;
        patientBreakdown[pId].commission += commissionInfo.commission;
        patientBreakdown[pId].hospitalShare += commissionInfo.hospitalShare;
        patientBreakdown[pId].visits += 1;
      }

      const serviceType = inv.invoice_type;
      if (!serviceBreakdown[serviceType]) {
        serviceBreakdown[serviceType] = {
          service: serviceType,
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          count: 0
        };
      }
      serviceBreakdown[serviceType].revenue += amount;
      serviceBreakdown[serviceType].commission += commissionInfo.commission;
      serviceBreakdown[serviceType].hospitalShare += commissionInfo.hospitalShare;
      serviceBreakdown[serviceType].count += 1;

      if (Array.isArray(inv.service_items) && inv.service_items.length) {
        inv.service_items.forEach((item) => {
          const itemName = item.name || 'Other Service';
          const key = `${serviceType} - ${itemName}`;
          if (!serviceBreakdown[key]) {
            serviceBreakdown[key] = {
              service: itemName,
              revenue: 0,
              commission: 0,
              hospitalShare: 0,
              count: 0
            };
          }
          serviceBreakdown[key].revenue += item.total_price || 0;
          const itemCommission = (item.total_price || 0) * (commissionInfo.commissionPercentage / 100);
          serviceBreakdown[key].commission += itemCommission;
          serviceBreakdown[key].hospitalShare += (item.total_price || 0) - itemCommission;
          serviceBreakdown[key].count += 1;
        });
      }
    });

    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([d, data]) => ({ 
        date: d, 
        revenue: data.revenue,
        commission: data.commission,
        hospitalShare: data.hospitalShare
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const patientBreakdownArray = Object.values(patientBreakdown).sort((a, b) => b.revenue - a.revenue);
    const serviceBreakdownArray = Object.values(serviceBreakdown)
      .map(s => ({
        ...s,
        percentage: totalRevenue > 0 ? Number(((s.revenue / totalRevenue) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({
      doctor: {
        id: doctor._id,
        name: `${doctor.firstName} ${doctor.lastName || ''}`.trim(),
        department: doctor.department,
        specialization: doctor.specialization,
        licenseNumber: doctor.licenseNumber,
        revenuePercentage: doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30),
        isFullTime: doctor.isFullTime
      },
      period: { start, end },
      summary: {
        totalRevenue,
        totalCommission,
        totalHospitalShare,
        commissionPercentage: doctor.isFullTime ? 0 : (doctor.revenuePercentage || 30),
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
        labTestCount,
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
 * Get department revenue report with proper commission
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

    const doctors = await Doctor.find({ department: deptObjId })
      .select('firstName lastName specialization department revenuePercentage isFullTime');
    const doctorIds = doctors.map((d) => d._id);

    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

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
    let totalDoctorEarnings = 0;
    let totalHospitalShare = 0;
    let appointmentCount = 0;
    let procedureCount = 0;
    let labTestCount = 0;
    let pharmacyCount = 0;

    const doctorBreakdown = {};
    const dailyRevenue = {};

    invoices.forEach((inv) => {
      const amount = inv.total || 0;
      
      const doctorId = inv.appointment_info?.doctor_id ? String(inv.appointment_info.doctor_id) : null;
      const doctor = doctorId ? doctorsMap.get(doctorId) : null;
      const commissionInfo = calculateDoctorCommission(doctor, amount, inv.invoice_type);

      totalRevenue += amount;
      totalDoctorEarnings += commissionInfo.commission;
      totalHospitalShare += commissionInfo.hospitalShare;

      if (inv.invoice_type === 'Appointment') appointmentCount += 1;
      if (inv.invoice_type === 'Procedure') procedureCount += 1;
      if (inv.invoice_type === 'Lab Test') labTestCount += 1;
      if (inv.invoice_type === 'Pharmacy') pharmacyCount += 1;

      const dateKey = new Date(inv.computed_date || inv.created_at || inv.createdAt).toISOString().split('T')[0];
      if (!dailyRevenue[dateKey]) {
        dailyRevenue[dateKey] = { revenue: 0, doctorEarnings: 0, hospitalShare: 0 };
      }
      dailyRevenue[dateKey].revenue += amount;
      dailyRevenue[dateKey].doctorEarnings += commissionInfo.commission;
      dailyRevenue[dateKey].hospitalShare += commissionInfo.hospitalShare;

      if (doctorId) {
        const d = inv.doctor_info;
        const name = d ? `${d.firstName} ${d.lastName || ''}`.trim() : 'Unknown';

        if (!doctorBreakdown[doctorId]) {
          doctorBreakdown[doctorId] = {
            id: doctorId,
            name,
            revenue: 0,
            earnings: 0,
            commission: 0,
            hospitalShare: 0,
            invoices: 0,
            isFullTime: doctor?.isFullTime || false,
            specialization: d?.specialization || 'N/A'
          };
        }
        doctorBreakdown[doctorId].revenue += amount;
        doctorBreakdown[doctorId].earnings += commissionInfo.commission;
        doctorBreakdown[doctorId].commission += commissionInfo.commission;
        doctorBreakdown[doctorId].hospitalShare += commissionInfo.hospitalShare;
        doctorBreakdown[doctorId].invoices += 1;
      }
    });

    const dailyBreakdown = Object.entries(dailyRevenue)
      .map(([d, data]) => ({ 
        date: d, 
        revenue: data.revenue,
        doctorEarnings: data.doctorEarnings,
        hospitalShare: data.hospitalShare
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const doctorBreakdownArray = Object.values(doctorBreakdown).sort((a, b) => b.revenue - a.revenue);

    const totalCommission = doctorBreakdownArray.reduce((sum, doc) => sum + doc.commission, 0);
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
        totalDoctorEarnings,
        totalHospitalShare,
        totalCommission,
        fullTimeCommission,
        partTimeCommission,
        averageCommissionRate: totalRevenue > 0 ? (totalCommission / totalRevenue * 100) : 0,
        totalInvoices: invoices.length,
        appointmentCount,
        procedureCount,
        labTestCount,
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
      doctors: doctors.map((d) => {
        const stats = doctorBreakdown[String(d._id)] || {};
        return {
          id: d._id,
          name: `${d.firstName} ${d.lastName || ''}`.trim(),
          specialization: d.specialization,
          revenuePercentage: d.revenuePercentage || (d.isFullTime ? 100 : 30),
          isFullTime: d.isFullTime || false,
          revenue: stats.revenue || 0,
          earnings: stats.earnings || 0,
          commission: stats.commission || 0,
          hospitalShare: stats.hospitalShare || 0,
          invoices: stats.invoices || 0
        };
      })
    });
  } catch (error) {
    console.error('Error getting department revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get detailed revenue report with proper commission
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

    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await Invoice.aggregate(countPipeline);
    const total = countResult[0]?.total || 0;

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
            id: '$doctor_info._id',
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
          lab_test_items: 1,
          notes: 1
        }
      }
    ];

    const invoices = await Invoice.aggregate(dataPipeline);

    // Get doctors for commission calculation
    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const invoicesWithCommission = invoices.map(inv => {
      const doctor = inv.doctor?.id ? doctorsMap.get(inv.doctor.id.toString()) : null;
      const commissionInfo = calculateDoctorCommission(doctor, inv.total || 0, inv.invoice_type);
      
      return {
        ...inv,
        commission: commissionInfo.commission,
        commission_percentage: commissionInfo.commissionPercentage,
        hospital_share: commissionInfo.hospitalShare,
        doctor_type: commissionInfo.doctorType,
        doctor_details: doctor ? {
          id: doctor._id,
          name: `${doctor.firstName} ${doctor.lastName || ''}`.trim(),
          isFullTime: doctor.isFullTime,
          revenuePercentage: doctor.revenuePercentage
        } : null
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
      procedureCount: invoicesWithCommission.filter((inv) => inv.invoice_type === 'Procedure').length,
      labTestCount: invoicesWithCommission.filter((inv) => inv.invoice_type === 'Lab Test').length
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
 * Get procedure revenue analytics with proper doctor commission
 */
exports.getProcedureRevenueAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, departmentId, doctorId, procedureCode, procedureCategory } = req.query;

    let startOfDayUTC, endOfDayUTC;
    
    if (startDate && endDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(endDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else if (startDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(startDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else {
      endOfDayUTC = new Date();
      startOfDayUTC = new Date();
      startOfDayUTC.setDate(startOfDayUTC.getDate() - 30);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC.setHours(23, 59, 59, 999);
    }

    const dateFilter = {
      $or: [
        { created_at: { $gte: startOfDayUTC, $lte: endOfDayUTC } },
        { createdAt: { $gte: startOfDayUTC, $lte: endOfDayUTC } }
      ]
    };

    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const pipeline = [
      { 
        $match: { 
          invoice_type: 'Procedure',
          ...dateFilter
        } 
      },
      { $unwind: { path: '$procedure_items', preserveNullAndEmptyArrays: false } },
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
          doctorId: { $ifNull: ['$doctor._id', null] },
          doctorName: { 
            $cond: {
              if: { $and: ['$doctor.firstName', '$doctor.lastName'] },
              then: { $concat: ['$doctor.firstName', ' ', '$doctor.lastName'] },
              else: 'Unknown'
            }
          },
          isFullTime: { $ifNull: ['$doctor.isFullTime', false] },
          revenuePercentage: { $ifNull: ['$doctor.revenuePercentage', 30] },
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

    if (doctorId && doctorId !== 'all' && doctorId !== 'undefined') {
      pipeline.push({ 
        $match: { 
          'appointment.doctor_id': new mongoose.Types.ObjectId(doctorId) 
        } 
      });
    }

    if (departmentId && departmentId !== 'all' && departmentId !== 'undefined') {
      pipeline.push({ 
        $match: { 
          'doctor.department': new mongoose.Types.ObjectId(departmentId) 
        } 
      });
    }

    if (procedureCode && procedureCode !== 'all') {
      pipeline.push({ 
        $match: { 
          'procedure_items.procedure_code': procedureCode 
        } 
      });
    }

    const procedureInvoices = await Invoice.aggregate(pipeline);

    const procedureStats = {};
    const doctorProcedureStats = {};
    const dailyProcedureStats = {};
    const departmentProcedureStats = {};

    let totalProcedureRevenue = 0;
    let totalProcedureCount = 0;
    let totalDoctorCommission = 0;
    let totalHospitalShare = 0;

    procedureInvoices.forEach(item => {
      const procCode = item.procedureCode || 'UNKNOWN';
      const procName = item.procedureName || 'Unknown Procedure';
      const revenue = item.procedureRevenue || 0;
      const quantity = item.procedureQuantity || 1;
      const doctorId = item.doctorId ? item.doctorId.toString() : 'unknown';
      const isFullTime = item.isFullTime || false;
      const revenuePercentage = item.revenuePercentage || (isFullTime ? 100 : 30);
      
      const commission = isFullTime ? 0 : (revenue * revenuePercentage / 100);
      const hospitalShare = revenue - commission;
      
      totalProcedureRevenue += revenue;
      totalProcedureCount += 1;
      totalDoctorCommission += commission;
      totalHospitalShare += hospitalShare;

      if (!procedureStats[procCode]) {
        procedureStats[procCode] = {
          code: procCode,
          name: procName,
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          quantity: 0,
          count: 0,
          averagePrice: 0
        };
      }
      procedureStats[procCode].revenue += revenue;
      procedureStats[procCode].commission += commission;
      procedureStats[procCode].hospitalShare += hospitalShare;
      procedureStats[procCode].quantity += quantity;
      procedureStats[procCode].count += 1;

      const key = `${doctorId}-${procCode}`;
      if (!doctorProcedureStats[key]) {
        doctorProcedureStats[key] = {
          doctorId,
          doctorName: item.doctorName || 'Unknown',
          isFullTime,
          revenuePercentage,
          procedureCode: procCode,
          procedureName: procName,
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          quantity: 0,
          count: 0
        };
      }
      doctorProcedureStats[key].revenue += revenue;
      doctorProcedureStats[key].commission += commission;
      doctorProcedureStats[key].hospitalShare += hospitalShare;
      doctorProcedureStats[key].quantity += quantity;
      doctorProcedureStats[key].count += 1;

      const deptId = item.departmentId ? item.departmentId.toString() : 'unknown';
      if (!departmentProcedureStats[deptId]) {
        departmentProcedureStats[deptId] = {
          departmentId: deptId,
          departmentName: deptId === 'unknown' ? 'Unknown' : 'Department',
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          count: 0
        };
      }
      departmentProcedureStats[deptId].revenue += revenue;
      departmentProcedureStats[deptId].commission += commission;
      departmentProcedureStats[deptId].hospitalShare += hospitalShare;
      departmentProcedureStats[deptId].count += 1;

      const dateKey = item.date || new Date().toISOString().split('T')[0];
      if (!dailyProcedureStats[dateKey]) {
        dailyProcedureStats[dateKey] = {
          date: dateKey,
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          quantity: 0,
          count: 0
        };
      }
      dailyProcedureStats[dateKey].revenue += revenue;
      dailyProcedureStats[dateKey].commission += commission;
      dailyProcedureStats[dateKey].hospitalShare += hospitalShare;
      dailyProcedureStats[dateKey].quantity += quantity;
      dailyProcedureStats[dateKey].count += 1;
    });

    Object.values(procedureStats).forEach(proc => {
      proc.averagePrice = proc.count > 0 ? proc.revenue / proc.count : 0;
    });

    const departments = await Department.find({});
    const deptMap = new Map(departments.map(d => [d._id.toString(), d.name]));

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
        totalDoctorCommission,
        totalHospitalShare,
        commissionRate: totalProcedureRevenue > 0 ? (totalDoctorCommission / totalProcedureRevenue) * 100 : 0
      },
      breakdown: {
        byProcedure: Object.values(procedureStats)
          .map(p => ({
            ...p,
            percentage: totalProcedureRevenue > 0 ? (p.revenue / totalProcedureRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        byDoctor: Object.values(doctorProcedureStats)
          .map(d => ({
            ...d,
            percentage: totalProcedureRevenue > 0 ? (d.revenue / totalProcedureRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        byDepartment: Object.entries(departmentProcedureStats)
          .map(([deptId, data]) => ({
            departmentId: deptId,
            departmentName: deptMap.get(deptId) || (deptId === 'unknown' ? 'Unknown' : 'Unknown Department'),
            revenue: data.revenue,
            commission: data.commission,
            hospitalShare: data.hospitalShare,
            count: data.count,
            percentage: totalProcedureRevenue > 0 ? (data.revenue / totalProcedureRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        daily: Object.values(dailyProcedureStats).sort((a, b) => new Date(a.date) - new Date(b.date))
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Error in getProcedureRevenueAnalytics:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      stack: error.stack 
    });
  }
};

/**
 * Get lab test revenue analytics with proper doctor commission
 */
exports.getLabTestRevenueAnalytics = async (req, res) => {
  try {
    const { startDate, endDate, departmentId, doctorId, labTestCode, labTestCategory, status } = req.query;

    let startOfDayUTC, endOfDayUTC;
    
    if (startDate && endDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(endDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else if (startDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(startDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else {
      endOfDayUTC = new Date();
      startOfDayUTC = new Date();
      startOfDayUTC.setDate(startOfDayUTC.getDate() - 30);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC.setHours(23, 59, 59, 999);
    }

    const dateFilter = {
      $or: [
        { created_at: { $gte: startOfDayUTC, $lte: endOfDayUTC } },
        { createdAt: { $gte: startOfDayUTC, $lte: endOfDayUTC } }
      ]
    };

    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const pipeline = [
      { 
        $match: { 
          invoice_type: 'Lab Test',
          ...dateFilter
        } 
      },
      { $unwind: { path: '$lab_test_items', preserveNullAndEmptyArrays: false } },
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
          labTestCode: '$lab_test_items.lab_test_code',
          labTestName: '$lab_test_items.lab_test_name',
          labTestRevenue: '$lab_test_items.total_price',
          labTestQuantity: '$lab_test_items.quantity',
          labTestUnitPrice: '$lab_test_items.unit_price',
          labTestStatus: '$lab_test_items.status',
          doctorId: { $ifNull: ['$doctor._id', null] },
          doctorName: { 
            $cond: {
              if: { $and: ['$doctor.firstName', '$doctor.lastName'] },
              then: { $concat: ['$doctor.firstName', ' ', '$doctor.lastName'] },
              else: 'Unknown'
            }
          },
          isFullTime: { $ifNull: ['$doctor.isFullTime', false] },
          revenuePercentage: { $ifNull: ['$doctor.revenuePercentage', 30] },
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

    if (doctorId && doctorId !== 'all' && doctorId !== 'undefined') {
      pipeline.push({ 
        $match: { 
          'appointment.doctor_id': new mongoose.Types.ObjectId(doctorId) 
        } 
      });
    }

    if (departmentId && departmentId !== 'all' && departmentId !== 'undefined') {
      pipeline.push({ 
        $match: { 
          'doctor.department': new mongoose.Types.ObjectId(departmentId) 
        } 
      });
    }

    if (labTestCode && labTestCode !== 'all') {
      pipeline.push({ 
        $match: { 
          'lab_test_items.lab_test_code': labTestCode 
        } 
      });
    }

    if (status && status !== 'all') {
      pipeline.push({ 
        $match: { 
          'lab_test_items.status': status 
        } 
      });
    }

    const labTestInvoices = await Invoice.aggregate(pipeline);

    const labTestStats = {};
    const doctorLabTestStats = {};
    const dailyLabTestStats = {};
    const departmentLabTestStats = {};
    const statusStats = {};

    let totalLabTestRevenue = 0;
    let totalLabTestCount = 0;
    let totalDoctorCommission = 0;
    let totalHospitalShare = 0;

    labTestInvoices.forEach(item => {
      const labCode = item.labTestCode || 'UNKNOWN';
      const labName = item.labTestName || 'Unknown Lab Test';
      const revenue = item.labTestRevenue || 0;
      const quantity = item.labTestQuantity || 1;
      const testStatus = item.labTestStatus || 'Pending';
      const doctorId = item.doctorId ? item.doctorId.toString() : 'unknown';
      const isFullTime = item.isFullTime || false;
      const revenuePercentage = item.revenuePercentage || (isFullTime ? 100 : 30);
      
      const commission = isFullTime ? 0 : (revenue * revenuePercentage / 100);
      const hospitalShare = revenue - commission;

      totalLabTestRevenue += revenue;
      totalLabTestCount += 1;
      totalDoctorCommission += commission;
      totalHospitalShare += hospitalShare;

      if (!statusStats[testStatus]) {
        statusStats[testStatus] = {
          status: testStatus,
          count: 0,
          revenue: 0,
          commission: 0,
          hospitalShare: 0
        };
      }
      statusStats[testStatus].count += 1;
      statusStats[testStatus].revenue += revenue;
      statusStats[testStatus].commission += commission;
      statusStats[testStatus].hospitalShare += hospitalShare;

      if (!labTestStats[labCode]) {
        labTestStats[labCode] = {
          code: labCode,
          name: labName,
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          quantity: 0,
          count: 0,
          averagePrice: 0,
          unitPrice: item.labTestUnitPrice
        };
      }
      labTestStats[labCode].revenue += revenue;
      labTestStats[labCode].commission += commission;
      labTestStats[labCode].hospitalShare += hospitalShare;
      labTestStats[labCode].quantity += quantity;
      labTestStats[labCode].count += 1;

      const key = `${doctorId}-${labCode}`;
      if (!doctorLabTestStats[key]) {
        doctorLabTestStats[key] = {
          doctorId,
          doctorName: item.doctorName || 'Unknown',
          isFullTime,
          revenuePercentage,
          labTestCode: labCode,
          labTestName: labName,
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          quantity: 0,
          count: 0
        };
      }
      doctorLabTestStats[key].revenue += revenue;
      doctorLabTestStats[key].commission += commission;
      doctorLabTestStats[key].hospitalShare += hospitalShare;
      doctorLabTestStats[key].quantity += quantity;
      doctorLabTestStats[key].count += 1;

      const deptId = item.departmentId ? item.departmentId.toString() : 'unknown';
      if (!departmentLabTestStats[deptId]) {
        departmentLabTestStats[deptId] = {
          departmentId: deptId,
          departmentName: deptId === 'unknown' ? 'Unknown' : 'Department',
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          count: 0
        };
      }
      departmentLabTestStats[deptId].revenue += revenue;
      departmentLabTestStats[deptId].commission += commission;
      departmentLabTestStats[deptId].hospitalShare += hospitalShare;
      departmentLabTestStats[deptId].count += 1;

      const dateKey = item.date || new Date().toISOString().split('T')[0];
      if (!dailyLabTestStats[dateKey]) {
        dailyLabTestStats[dateKey] = {
          date: dateKey,
          revenue: 0,
          commission: 0,
          hospitalShare: 0,
          quantity: 0,
          count: 0
        };
      }
      dailyLabTestStats[dateKey].revenue += revenue;
      dailyLabTestStats[dateKey].commission += commission;
      dailyLabTestStats[dateKey].hospitalShare += hospitalShare;
      dailyLabTestStats[dateKey].quantity += quantity;
      dailyLabTestStats[dateKey].count += 1;
    });

    Object.values(labTestStats).forEach(test => {
      test.averagePrice = test.count > 0 ? test.revenue / test.count : 0;
    });

    const departments = await Department.find({});
    const deptMap = new Map(departments.map(d => [d._id.toString(), d.name]));

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
        totalLabTestRevenue,
        totalLabTests: totalLabTestCount,
        uniqueLabTests: Object.keys(labTestStats).length,
        averageLabTestValue: totalLabTestCount > 0 ? totalLabTestRevenue / totalLabTestCount : 0,
        totalDoctorCommission,
        totalHospitalShare,
        commissionRate: totalLabTestRevenue > 0 ? (totalDoctorCommission / totalLabTestRevenue) * 100 : 0
      },
      breakdown: {
        byStatus: Object.values(statusStats)
          .map(s => ({
            ...s,
            percentage: totalLabTestRevenue > 0 ? (s.revenue / totalLabTestRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        byLabTest: Object.values(labTestStats)
          .map(t => ({
            ...t,
            percentage: totalLabTestRevenue > 0 ? (t.revenue / totalLabTestRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        byDoctor: Object.values(doctorLabTestStats)
          .map(d => ({
            ...d,
            percentage: totalLabTestRevenue > 0 ? (d.revenue / totalLabTestRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        byDepartment: Object.entries(departmentLabTestStats)
          .map(([deptId, data]) => ({
            departmentId: deptId,
            departmentName: deptMap.get(deptId) || (deptId === 'unknown' ? 'Unknown' : 'Unknown Department'),
            revenue: data.revenue,
            commission: data.commission,
            hospitalShare: data.hospitalShare,
            count: data.count,
            percentage: totalLabTestRevenue > 0 ? (data.revenue / totalLabTestRevenue) * 100 : 0
          }))
          .sort((a, b) => b.revenue - a.revenue),
        daily: Object.values(dailyLabTestStats).sort((a, b) => new Date(a.date) - new Date(b.date))
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Error in getLabTestRevenueAnalytics:', error);
    res.status(500).json({ 
      success: false,
      error: error.message,
      stack: error.stack 
    });
  }
};

// Export functions (these would be similarly updated with commission logic)
exports.exportRevenueData = async (req, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      exportType = 'csv',
      includeCommissionSplit = true
    } = req.query;

    const filter = {};
    if (startDate && endDate) {
      filter.$or = [
        { created_at: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } },
        { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } }
      ];
    }

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

    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const exportData = invoices.map((invoice) => {
      const doctor = invoice.appointment_id?.doctor_id;
      const patient = invoice.patient_id;
      const doctorObj = doctor ? doctorsMap.get(doctor._id.toString()) : null;
      const commissionInfo = calculateDoctorCommission(doctorObj, invoice.total || 0, invoice.invoice_type);
      
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
        'Doctor Type': doctorObj?.isFullTime ? 'Full-time' : 'Part-time',
        'Specialization': doctor?.specialization || 'N/A',
        'Department': doctor?.department || 'N/A',
        'Total Amount': invoice.total || 0,
        'Doctor Commission': includeCommissionSplit ? commissionInfo.commission : 'N/A',
        'Commission %': includeCommissionSplit ? commissionInfo.commissionPercentage : 'N/A',
        'Hospital Share': includeCommissionSplit ? commissionInfo.hospitalShare : 'N/A',
        'Amount Paid': invoice.amount_paid || 0,
        'Balance Due': invoice.balance_due || 0,
        'Status': invoice.status,
        'Payment Method': Array.isArray(invoice.payment_history) && invoice.payment_history.length
            ? invoice.payment_history[invoice.payment_history.length - 1].method
            : 'N/A',
        'Services Count': invoice.service_items?.length || 0,
        'Medicines Count': invoice.medicine_items?.length || 0,
        'Procedures Count': invoice.procedure_items?.length || 0,
        'Lab Tests Count': invoice.lab_test_items?.length || 0,
        'Total Services Value': invoice.service_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Total Medicines Value': invoice.medicine_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Total Procedures Value': invoice.procedure_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Total Lab Tests Value': invoice.lab_test_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Notes': invoice.notes || ''
      };
    });

    if (exportType === 'csv') {
      const headers = Object.keys(exportData[0] || {});
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
      res.status(400).json({ error: 'Unsupported export type' });
    }
  } catch (error) {
    console.error('Error exporting revenue data:', error);
    res.status(500).json({ error: error.message });
  }
};

// Placeholder exports for other export functions (would be similarly updated)
exports.exportOverview = async (req, res) => {
  try {
    const { exportType = 'csv' } = req.query;
    
    const { pipeline, period } = buildInvoicePipeline(req.query, {
      requireDoctorJoin: true,
      requirePatientJoin: true
    });

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
    
    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const bifurcation = calculateRevenueBifurcation(invoices, doctorsMap);

    const overviewData = [{
      'Period': `${req.query.startDate || 'Start'} to ${req.query.endDate || 'End'}`,
      'Total Invoices': invoices.length,
      'Total Revenue': bifurcation.totalRevenue,
      'Doctor Earnings': bifurcation.doctorEarnings,
      'Hospital Revenue': bifurcation.hospitalRevenue,
      'Total Commission': bifurcation.totalCommission,
      'Net Hospital Revenue': bifurcation.netHospitalRevenue,
      'Profit Margin': `${bifurcation.profitMargin?.toFixed(1) || 0}%`,
      'Collection Rate': invoices.length > 0 
        ? `${((invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0) / bifurcation.totalRevenue) * 100).toFixed(1)}%`
        : '0%'
    }];

    if (exportType === 'csv') {
      const headers = Object.keys(overviewData[0]);
      const csvLines = [
        headers.join(','),
        ...overviewData.map((row) =>
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
      res.setHeader('Content-Disposition', `attachment; filename=overview_export_${Date.now()}.csv`);
      return res.send(csvContent);
    } else {
      return res.json({
        period,
        data: overviewData,
        bifurcation
      });
    }
  } catch (error) {
    console.error('Error exporting overview:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Daily Report with proper commission logic
 */
exports.exportDaily = async (req, res) => {
  try {
    const { date, exportType = 'csv', doctorId, departmentId, invoiceType, paymentMethod } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required for daily export' });
    }

    const dateStr = date;
    const istDate = new Date(`${dateStr}T00:00:00.000+05:30`);
    const istEndDate = new Date(`${dateStr}T23:59:59.999+05:30`);
    
    const startOfDayUTC = new Date(istDate.toISOString());
    const endOfDayUTC = new Date(istEndDate.toISOString());

    const matchStage = {
      $or: [
        { created_at: { $gte: startOfDayUTC, $lte: endOfDayUTC } },
        { createdAt: { $gte: startOfDayUTC, $lte: endOfDayUTC } }
      ]
    };

    if (invoiceType && invoiceType !== 'all') {
      matchStage.invoice_type = invoiceType;
    }

    const invoices = await Invoice.find(matchStage)
      .populate('patient_id', 'first_name last_name patientId patient_type')
      .populate({
        path: 'appointment_id',
        populate: {
          path: 'doctor_id',
          select: 'firstName lastName specialization revenuePercentage isFullTime department'
        }
      })
      .lean();

    // Get doctors map for commission calculation
    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    // Apply additional filters in memory
    let filteredInvoices = invoices;
    
    if (doctorId && doctorId !== 'all') {
      filteredInvoices = filteredInvoices.filter(inv => 
        inv.appointment_id?.doctor_id?._id?.toString() === doctorId
      );
    }

    if (departmentId && departmentId !== 'all') {
      filteredInvoices = filteredInvoices.filter(inv => 
        inv.appointment_id?.doctor_id?.department?.toString() === departmentId
      );
    }

    if (paymentMethod && paymentMethod !== 'all') {
      filteredInvoices = filteredInvoices.filter(inv => 
        inv.payment_history?.some(p => p.method === paymentMethod)
      );
    }

    // Prepare export data
    const exportData = [];
    let totalRevenue = 0;
    let totalDoctorEarnings = 0;
    let totalHospitalShare = 0;
    let totalPaid = 0;
    let totalPending = 0;

    filteredInvoices.forEach(invoice => {
      if (['Draft', 'Cancelled'].includes(invoice.status)) return;

      const amount = invoice.total || 0;
      const doctor = invoice.appointment_id?.doctor_id;
      const doctorObj = doctor ? doctorsMap.get(doctor._id.toString()) : null;
      const commissionInfo = calculateDoctorCommission(doctorObj, amount, invoice.invoice_type);
      const dateField = invoice.created_at || invoice.createdAt;
      const istTime = new Date(dateField).toLocaleString('en-IN', { 
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      totalRevenue += amount;
      totalDoctorEarnings += commissionInfo.commission;
      totalHospitalShare += commissionInfo.hospitalShare;
      totalPaid += invoice.amount_paid || 0;
      totalPending += invoice.balance_due || 0;

      exportData.push({
        'Invoice Number': invoice.invoice_number,
        'Time (IST)': istTime,
        'Type': invoice.invoice_type,
        'Patient Name': invoice.patient_id ? 
          `${invoice.patient_id.first_name || ''} ${invoice.patient_id.last_name || ''}`.trim() : 
          'Walk-in',
        'Patient ID': invoice.patient_id?.patientId || 'N/A',
        'Patient Type': invoice.patient_id?.patient_type || 'N/A',
        'Doctor': doctor ? `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim() : 'Not assigned',
        'Doctor Type': doctorObj?.isFullTime ? 'Full-time' : 'Part-time',
        'Commission %': commissionInfo.commissionPercentage,
        'Total Amount': amount,
        'Doctor Commission': commissionInfo.commission,
        'Hospital Share': commissionInfo.hospitalShare,
        'Amount Paid': invoice.amount_paid || 0,
        'Balance Due': invoice.balance_due || 0,
        'Status': invoice.status,
        'Payment Method': invoice.payment_history?.length > 0 
          ? invoice.payment_history[invoice.payment_history.length - 1].method 
          : 'N/A',
        'Services Count': invoice.service_items?.length || 0,
        'Medicines Count': invoice.medicine_items?.length || 0,
        'Procedures Count': invoice.procedure_items?.length || 0,
        'Lab Tests Count': invoice.lab_test_items?.length || 0,
        'Notes': invoice.notes || ''
      });
    });

    // Add summary rows
    const summaryRow = {
      'Invoice Number': '=== DAILY SUMMARY ===',
      'Time (IST)': '',
      'Type': '',
      'Patient Name': '',
      'Patient ID': '',
      'Patient Type': '',
      'Doctor': '',
      'Doctor Type': '',
      'Commission %': '',
      'Total Amount': totalRevenue,
      'Doctor Commission': totalDoctorEarnings,
      'Hospital Share': totalHospitalShare,
      'Amount Paid': totalPaid,
      'Balance Due': totalPending,
      'Status': '',
      'Payment Method': '',
      'Services Count': filteredInvoices.reduce((sum, inv) => sum + (inv.service_items?.length || 0), 0),
      'Medicines Count': filteredInvoices.reduce((sum, inv) => sum + (inv.medicine_items?.length || 0), 0),
      'Procedures Count': filteredInvoices.reduce((sum, inv) => sum + (inv.procedure_items?.length || 0), 0),
      'Lab Tests Count': filteredInvoices.reduce((sum, inv) => sum + (inv.lab_test_items?.length || 0), 0),
      'Notes': `Date: ${dateStr} | Total Invoices: ${filteredInvoices.length}`
    };

    exportData.unshift(summaryRow);

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Daily Revenue');
      
      const headers = Object.keys(exportData[0]);
      worksheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: header === 'Notes' ? 40 : 20
      }));

      exportData.forEach(row => {
        worksheet.addRow(row);
      });

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(2).font = { bold: true };
      worksheet.getRow(2).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF0F0F0' }
      };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=daily_revenue_${dateStr}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // CSV format
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
      res.setHeader('Content-Disposition', `attachment; filename=daily_revenue_${dateStr}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting daily data:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Monthly Report with proper commission logic
 */
exports.exportMonthly = async (req, res) => {
  try {
    const { year, month, exportType = 'csv', doctorId, departmentId, invoiceType, paymentMethod, patientType } = req.query;
    
    if (!year || !month) {
      return res.status(400).json({ error: 'Year and month are required for monthly export' });
    }

    const targetYear = parseInt(year, 10);
    const targetMonth = parseInt(month, 10);

    const startDate = new Date(Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999));

    const query = {
      $or: [
        { created_at: { $gte: startDate, $lte: endDate } },
        { createdAt: { $gte: startDate, $lte: endDate } }
      ]
    };

    if (invoiceType && invoiceType !== 'all') query.invoice_type = invoiceType;

    let invoices = await Invoice.find(query)
      .populate('patient_id', 'first_name last_name patientId patient_type')
      .populate({
        path: 'appointment_id',
        populate: { 
          path: 'doctor_id', 
          select: 'firstName lastName department specialization revenuePercentage isFullTime' 
        }
      })
      .lean();

    // Apply filters
    if (doctorId && doctorId !== 'all') {
      invoices = invoices.filter(inv => 
        inv.appointment_id?.doctor_id?._id?.toString() === doctorId
      );
    }

    if (departmentId && departmentId !== 'all') {
      invoices = invoices.filter(inv => 
        inv.appointment_id?.doctor_id?.department?.toString() === departmentId
      );
    }

    if (patientType && patientType !== 'all') {
      invoices = invoices.filter(inv => 
        inv.patient_id?.patient_type === patientType
      );
    }

    if (paymentMethod && paymentMethod !== 'all') {
      invoices = invoices.filter(inv => 
        inv.payment_history?.some(p => p.method === paymentMethod)
      );
    }

    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    // Prepare export data - weekly breakdown
    const weeklyData = {};
    let totalRevenue = 0;
    let totalDoctorEarnings = 0;
    let totalHospitalShare = 0;

    invoices.forEach(invoice => {
      if (['Draft', 'Cancelled'].includes(invoice.status)) return;

      const amount = invoice.total || 0;
      const doctor = invoice.appointment_id?.doctor_id;
      const doctorObj = doctor ? doctorsMap.get(doctor._id.toString()) : null;
      const commissionInfo = calculateDoctorCommission(doctorObj, amount, invoice.invoice_type);
      
      let dateField;
      if (invoice.created_at) dateField = invoice.created_at;
      else if (invoice.createdAt) dateField = invoice.createdAt;
      else dateField = new Date();

      const dateObj = new Date(dateField);
      const day = dateObj.getDate();
      const week = Math.ceil(day / 7);
      const weekKey = `Week ${week}`;

      totalRevenue += amount;
      totalDoctorEarnings += commissionInfo.commission;
      totalHospitalShare += commissionInfo.hospitalShare;

      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = {
          week: weekKey,
          days: `${(week - 1) * 7 + 1}-${Math.min(week * 7, new Date(targetYear, targetMonth, 0).getDate())}`,
          revenue: 0,
          doctorEarnings: 0,
          hospitalShare: 0,
          invoices: 0,
          appointments: 0,
          procedures: 0,
          labTests: 0,
          pharmacy: 0
        };
      }

      weeklyData[weekKey].revenue += amount;
      weeklyData[weekKey].doctorEarnings += commissionInfo.commission;
      weeklyData[weekKey].hospitalShare += commissionInfo.hospitalShare;
      weeklyData[weekKey].invoices += 1;
      
      if (invoice.invoice_type === 'Appointment') weeklyData[weekKey].appointments += 1;
      if (invoice.invoice_type === 'Procedure') weeklyData[weekKey].procedures += 1;
      if (invoice.invoice_type === 'Lab Test') weeklyData[weekKey].labTests += 1;
      if (invoice.invoice_type === 'Pharmacy') weeklyData[weekKey].pharmacy += 1;
    });

    const exportData = Object.values(weeklyData).sort((a, b) => a.week.localeCompare(b.week));

    // Add summary row
    const summaryRow = {
      week: 'MONTHLY TOTAL',
      days: `${targetYear}-${String(targetMonth).padStart(2, '0')}`,
      revenue: totalRevenue,
      doctorEarnings: totalDoctorEarnings,
      hospitalShare: totalHospitalShare,
      invoices: invoices.length,
      appointments: invoices.filter(i => i.invoice_type === 'Appointment').length,
      procedures: invoices.filter(i => i.invoice_type === 'Procedure').length,
      labTests: invoices.filter(i => i.invoice_type === 'Lab Test').length,
      pharmacy: invoices.filter(i => i.invoice_type === 'Pharmacy').length
    };

    exportData.push(summaryRow);

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Monthly Revenue');
      
      worksheet.columns = [
        { header: 'Week', key: 'week', width: 15 },
        { header: 'Days', key: 'days', width: 15 },
        { header: 'Revenue', key: 'revenue', width: 15 },
        { header: 'Doctor Earnings', key: 'doctorEarnings', width: 15 },
        { header: 'Hospital Share', key: 'hospitalShare', width: 15 },
        { header: 'Invoices', key: 'invoices', width: 10 },
        { header: 'Appointments', key: 'appointments', width: 12 },
        { header: 'Procedures', key: 'procedures', width: 12 },
        { header: 'Lab Tests', key: 'labTests', width: 12 },
        { header: 'Pharmacy', key: 'pharmacy', width: 12 }
      ];

      exportData.forEach(row => {
        worksheet.addRow(row);
      });

      worksheet.getRow(exportData.length).font = { bold: true };
      worksheet.getRow(exportData.length).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF0F0F0' }
      };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=monthly_revenue_${targetYear}_${targetMonth}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      const headers = ['Week', 'Days', 'Revenue', 'Doctor Earnings', 'Hospital Share', 'Invoices', 'Appointments', 'Procedures', 'Lab Tests', 'Pharmacy'];
      const csvLines = [
        headers.join(','),
        ...exportData.map((row) =>
          headers
            .map((h) => {
              const key = h.toLowerCase().replace(/ /g, '');
              const v = row[key] ?? row[h.toLowerCase()] ?? '';
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
      res.setHeader('Content-Disposition', `attachment; filename=monthly_revenue_${targetYear}_${targetMonth}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting monthly data:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Doctor Report with proper commission logic
 */
exports.exportDoctor = async (req, res) => {
  try {
    const { doctorId, startDate, endDate, exportType = 'csv', invoiceType } = req.query;
    
    if (!doctorId) {
      return res.status(400).json({ error: 'Doctor ID is required' });
    }

    const doctorObjId = toObjectId(doctorId);
    if (!doctorObjId) return res.status(400).json({ error: 'Invalid doctorId' });

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

    const match = { 
      $or: [
        { created_at: { $gte: start, $lte: end } },
        { createdAt: { $gte: start, $lte: end } }
      ]
    };
    if (invoiceType && invoiceType !== 'all') match.invoice_type = invoiceType;
    pipeline.push({ $match: match });

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

    pipeline.push({
      $addFields: {
        computed_date: { $ifNull: ['$created_at', '$createdAt'] }
      }
    });

    const invoices = await Invoice.aggregate(pipeline);

    const doctor = await Doctor.findById(doctorObjId);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    // Prepare export data
    const exportData = [];
    let totalRevenue = 0;
    let totalCommission = 0;
    let totalHospitalShare = 0;

    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const commissionInfo = calculateDoctorCommission(doctor, amount, invoice.invoice_type);
      const dateField = invoice.computed_date || invoice.created_at || invoice.createdAt;

      totalRevenue += amount;
      totalCommission += commissionInfo.commission;
      totalHospitalShare += commissionInfo.hospitalShare;

      exportData.push({
        'Date': new Date(dateField).toISOString().split('T')[0],
        'Invoice Number': invoice.invoice_number,
        'Type': invoice.invoice_type,
        'Patient Name': invoice.patient_info ? 
          `${invoice.patient_info.first_name || ''} ${invoice.patient_info.last_name || ''}`.trim() : 
          'Unknown',
        'Patient ID': invoice.patient_info?.patientId || 'N/A',
        'Total Amount': amount,
        'Commission %': commissionInfo.commissionPercentage,
        'Commission Amount': commissionInfo.commission,
        'Hospital Share': commissionInfo.hospitalShare,
        'Amount Paid': invoice.amount_paid || 0,
        'Status': invoice.status
      });
    });

    // Add summary
    const summaryRow = {
      'Date': '=== SUMMARY ===',
      'Invoice Number': '',
      'Type': '',
      'Patient Name': '',
      'Patient ID': '',
      'Total Amount': totalRevenue,
      'Commission %': doctor.isFullTime ? 0 : (doctor.revenuePercentage || 30),
      'Commission Amount': totalCommission,
      'Hospital Share': totalHospitalShare,
      'Amount Paid': invoices.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0),
      'Status': `Total Invoices: ${invoices.length}`
    };

    exportData.unshift(summaryRow);

    const doctorInfo = {
      'Doctor Name': `${doctor.firstName} ${doctor.lastName || ''}`.trim(),
      'Doctor Type': doctor.isFullTime ? 'Full-time (Salary)' : 'Part-time (Commission)',
      'Commission Rate': doctor.isFullTime ? 'N/A (Salaried)' : `${doctor.revenuePercentage || 30}%`,
      'Period': `${startDate || start.toISOString().split('T')[0]} to ${endDate || end.toISOString().split('T')[0]}`
    };

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      
      // Info sheet
      const infoSheet = workbook.addWorksheet('Doctor Info');
      infoSheet.columns = [
        { header: 'Field', key: 'field', width: 25 },
        { header: 'Value', key: 'value', width: 30 }
      ];

      Object.entries(doctorInfo).forEach(([key, value]) => {
        infoSheet.addRow({ field: key, value });
      });

      // Transactions sheet
      const transSheet = workbook.addWorksheet('Transactions');
      const headers = Object.keys(exportData[0]);
      transSheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: header === 'Patient Name' ? 25 : 15
      }));

      exportData.forEach(row => {
        transSheet.addRow(row);
      });

      transSheet.getRow(1).font = { bold: true };
      transSheet.getRow(2).font = { bold: true };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=doctor_${doctor.firstName}_${doctor.lastName}_${Date.now()}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      const allData = [doctorInfo, ...exportData];
      const headers = Object.keys(allData[0]);
      const csvLines = [
        headers.join(','),
        ...allData.map((row) =>
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
 * Export Department Report with proper commission logic
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

    const doctors = await Doctor.find({ department: deptObjId })
      .select('firstName lastName specialization department revenuePercentage isFullTime');
    const doctorIds = doctors.map((d) => d._id);

    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

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

    // Prepare doctor performance data
    const doctorPerformance = {};
    let totalRevenue = 0;
    let totalDoctorEarnings = 0;
    let totalHospitalShare = 0;

    invoices.forEach(invoice => {
      const amount = invoice.total || 0;
      const doctor = invoice.doctor_info;
      if (!doctor) return;

      const doctorId = doctor._id.toString();
      const commissionInfo = calculateDoctorCommission(doctor, amount, invoice.invoice_type);

      totalRevenue += amount;
      totalDoctorEarnings += commissionInfo.commission;
      totalHospitalShare += commissionInfo.hospitalShare;

      if (!doctorPerformance[doctorId]) {
        doctorPerformance[doctorId] = {
          doctorId,
          name: `${doctor.firstName} ${doctor.lastName || ''}`.trim(),
          revenue: 0,
          earnings: 0,
          commission: 0,
          hospitalShare: 0,
          invoices: 0,
          isFullTime: doctor.isFullTime || false,
          specialization: doctor.specialization || 'N/A',
          commissionPercentage: doctor.revenuePercentage || (doctor.isFullTime ? 100 : 30)
        };
      }

      doctorPerformance[doctorId].revenue += amount;
      doctorPerformance[doctorId].earnings += commissionInfo.commission;
      doctorPerformance[doctorId].commission += commissionInfo.commission;
      doctorPerformance[doctorId].hospitalShare += commissionInfo.hospitalShare;
      doctorPerformance[doctorId].invoices += 1;
    });

    const exportData = Object.values(doctorPerformance).sort((a, b) => b.revenue - a.revenue);

    // Add summary
    const summaryRow = {
      doctorId: 'DEPARTMENT TOTAL',
      name: dept.name || 'Unknown',
      revenue: totalRevenue,
      earnings: totalDoctorEarnings,
      commission: totalDoctorEarnings,
      hospitalShare: totalHospitalShare,
      invoices: invoices.length,
      isFullTime: '—',
      specialization: '—',
      commissionPercentage: totalRevenue > 0 ? ((totalDoctorEarnings / totalRevenue) * 100).toFixed(1) : 0
    };

    exportData.push(summaryRow);

    const deptInfo = {
      'Department': dept.name || 'Unknown',
      'Period': `${startDate || 'Start'} to ${endDate || 'End'}`,
      'Total Doctors': doctors.length,
      'Active Doctors': Object.keys(doctorPerformance).length,
      'Total Invoices': invoices.length,
      'Total Revenue': totalRevenue,
      'Total Doctor Earnings': totalDoctorEarnings,
      'Hospital Share': totalHospitalShare,
      'Avg Commission Rate': totalRevenue > 0 ? `${((totalDoctorEarnings / totalRevenue) * 100).toFixed(1)}%` : '0%'
    };

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      
      // Info sheet
      const infoSheet = workbook.addWorksheet('Department Info');
      infoSheet.columns = [
        { header: 'Metric', key: 'metric', width: 25 },
        { header: 'Value', key: 'value', width: 30 }
      ];

      Object.entries(deptInfo).forEach(([key, value]) => {
        infoSheet.addRow({ metric: key, value });
      });

      // Doctors sheet
      const doctorSheet = workbook.addWorksheet('Doctors');
      const headers = Object.keys(exportData[0]);
      doctorSheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: header === 'name' ? 25 : 15
      }));

      exportData.forEach(row => {
        doctorSheet.addRow(row);
      });

      doctorSheet.getRow(1).font = { bold: true };
      doctorSheet.getRow(exportData.length).font = { bold: true };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=department_${dept.name.replace(/\s+/g, '_')}_${Date.now()}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
    } else {
      const allData = [deptInfo, ...exportData];
      const headers = Object.keys(allData[0]);
      const csvLines = [
        headers.join(','),
        ...allData.map((row) =>
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
 * Export Detailed Report with proper commission logic
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

    const filter = {};
    if (startDate && endDate) {
      filter.$or = [
        { created_at: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } },
        { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } }
      ];
    }

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

    if (departmentId && departmentId !== 'all') {
      const doctorsInDept = await Doctor.find({ department: toObjectId(departmentId) }).select('_id');
      const doctorIds = doctorsInDept.map(d => d._id);
      filter['appointment_id.doctor_id'] = { $in: doctorIds };
    }

    const invoices = await Invoice.find(filter)
      .populate('patient_id', 'first_name last_name patientId patient_type')
      .populate({
        path: 'appointment_id',
        populate: { 
          path: 'doctor_id', 
          select: 'firstName lastName department revenuePercentage isFullTime specialization' 
        }
      })
      .sort({ created_at: -1, createdAt: -1 })
      .limit(100000);

    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const exportData = invoices.map((invoice) => {
      const doctor = invoice.appointment_id?.doctor_id;
      const patient = invoice.patient_id;
      const doctorObj = doctor ? doctorsMap.get(doctor._id.toString()) : null;
      const commissionInfo = calculateDoctorCommission(doctorObj, invoice.total || 0, invoice.invoice_type);
      
      const dateField = invoice.created_at || invoice.createdAt;
      const istDateTime = new Date(dateField).toLocaleString('en-IN', { 
        timeZone: 'Asia/Kolkata',
        dateStyle: 'short',
        timeStyle: 'medium'
      });

      return {
        'Invoice Number': invoice.invoice_number,
        'Date & Time (IST)': istDateTime,
        'Type': invoice.invoice_type,
        'Patient Name': patient ? `${patient.first_name} ${patient.last_name || ''}`.trim() : 'Unknown',
        'Patient ID': patient?.patientId || 'N/A',
        'Patient Type': patient?.patient_type || 'N/A',
        'Doctor': doctor ? `${doctor.firstName} ${doctor.lastName || ''}`.trim() : 'N/A',
        'Doctor Type': doctorObj?.isFullTime ? 'Full-time' : 'Part-time',
        'Specialization': doctor?.specialization || 'N/A',
        'Department': doctor?.department || 'N/A',
        'Total Amount': invoice.total || 0,
        'Doctor Commission': includeCommissionSplit ? commissionInfo.commission : 'N/A',
        'Commission %': includeCommissionSplit ? commissionInfo.commissionPercentage : 'N/A',
        'Hospital Share': includeCommissionSplit ? commissionInfo.hospitalShare : 'N/A',
        'Amount Paid': invoice.amount_paid || 0,
        'Balance Due': invoice.balance_due || 0,
        'Status': invoice.status,
        'Payment Method': invoice.payment_history?.length > 0
          ? invoice.payment_history[invoice.payment_history.length - 1].method
          : 'N/A',
        'Services Count': invoice.service_items?.length || 0,
        'Medicines Count': invoice.medicine_items?.length || 0,
        'Procedures Count': invoice.procedure_items?.length || 0,
        'Lab Tests Count': invoice.lab_test_items?.length || 0,
        'Total Services Value': invoice.service_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Total Medicines Value': invoice.medicine_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Total Procedures Value': invoice.procedure_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Total Lab Tests Value': invoice.lab_test_items?.reduce((sum, item) => sum + (item.total_price || 0), 0) || 0,
        'Notes': invoice.notes || ''
      };
    });

    if (exportData.length === 0) {
      const emptyRow = {
        'Invoice Number': 'No data found',
        'Date & Time (IST)': '',
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
        'Lab Tests Count': 0,
        'Total Services Value': 0,
        'Total Medicines Value': 0,
        'Total Procedures Value': 0,
        'Total Lab Tests Value': 0,
        'Notes': `No invoices found for period: ${startDate || 'Start'} to ${endDate || 'End'}`
      };
      exportData.push(emptyRow);
    }

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Detailed Revenue');
      
      const headers = Object.keys(exportData[0]);
      worksheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: header.includes('Date') ? 25 : 20
      }));

      exportData.forEach(row => {
        worksheet.addRow(row);
      });

      worksheet.getRow(1).font = { bold: true };

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
          balance: invoices.reduce((sum, inv) => sum + (inv.balance_due || 0), 0),
          commission: invoices.reduce((sum, inv) => {
            const doctor = inv.appointment_id?.doctor_id;
            const doctorObj = doctor ? doctorsMap.get(doctor._id.toString()) : null;
            const commissionInfo = calculateDoctorCommission(doctorObj, inv.total || 0, inv.invoice_type);
            return sum + commissionInfo.commission;
          }, 0),
          hospitalShare: invoices.reduce((sum, inv) => {
            const doctor = inv.appointment_id?.doctor_id;
            const doctorObj = doctor ? doctorsMap.get(doctor._id.toString()) : null;
            const commissionInfo = calculateDoctorCommission(doctorObj, inv.total || 0, inv.invoice_type);
            return sum + commissionInfo.hospitalShare;
          }, 0)
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

/**
 * Export Procedure Revenue Report with proper commission logic
 */
exports.exportProcedureRevenue = async (req, res) => {
  try {
    const { startDate, endDate, exportType = 'csv', doctorId, departmentId, procedureCode } = req.query;

    let startOfDayUTC, endOfDayUTC;
    
    if (startDate && endDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(endDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else if (startDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(startDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else {
      endOfDayUTC = new Date();
      startOfDayUTC = new Date();
      startOfDayUTC.setDate(startOfDayUTC.getDate() - 30);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC.setHours(23, 59, 59, 999);
    }

    const dateFilter = {
      $or: [
        { created_at: { $gte: startOfDayUTC, $lte: endOfDayUTC } },
        { createdAt: { $gte: startOfDayUTC, $lte: endOfDayUTC } }
      ]
    };

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
          isFullTime: '$doctor.isFullTime',
          revenuePercentage: '$doctor.revenuePercentage',
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

    if (procedureCode && procedureCode !== 'all') {
      pipeline.push({ $match: { 'procedure_items.procedure_code': procedureCode } });
    }

    const procedureItems = await Invoice.aggregate(pipeline);

    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const exportData = procedureItems.map(item => {
      const doctor = item.doctorId ? doctorsMap.get(item.doctorId.toString()) : null;
      const commissionInfo = calculateDoctorCommission(doctor, item.procedureRevenue || 0, 'Procedure');
      
      return {
        'Date': item.date,
        'Invoice Ref': item.invoice_number || 'N/A',
        'Procedure Code': item.procedureCode,
        'Procedure Name': item.procedureName,
        'Quantity': item.procedureQuantity || 1,
        'Revenue': item.procedureRevenue || 0,
        'Doctor': item.doctorName || 'Unknown',
        'Doctor Type': doctor?.isFullTime ? 'Full-time' : 'Part-time',
        'Commission %': commissionInfo.commissionPercentage,
        'Commission Amount': commissionInfo.commission,
        'Hospital Share': commissionInfo.hospitalShare,
        'Department': item.departmentId || 'Unknown'
      };
    });

    const totalRevenue = exportData.reduce((sum, item) => sum + item.Revenue, 0);
    const totalCommission = exportData.reduce((sum, item) => sum + item['Commission Amount'], 0);
    const totalHospitalShare = exportData.reduce((sum, item) => sum + item['Hospital Share'], 0);

    const summaryRow = {
      'Date': '=== SUMMARY ===',
      'Invoice Ref': '',
      'Procedure Code': '',
      'Procedure Name': '',
      'Quantity': exportData.length,
      'Revenue': totalRevenue,
      'Doctor': '',
      'Doctor Type': '',
      'Commission %': '',
      'Commission Amount': totalCommission,
      'Hospital Share': totalHospitalShare,
      'Department': ''
    };

    exportData.unshift(summaryRow);

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Procedure Revenue');
      
      const headers = Object.keys(exportData[0]);
      worksheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: header.includes('Name') ? 30 : 15
      }));

      exportData.forEach(row => {
        worksheet.addRow(row);
      });

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(2).font = { bold: true };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=procedure_revenue_${startDate || 'all'}_to_${endDate || 'now'}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
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
      res.setHeader('Content-Disposition', `attachment; filename=procedure_revenue_${startDate || 'all'}_to_${endDate || 'now'}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting procedure revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Export Lab Test Revenue Report with proper commission logic
 */
exports.exportLabTestRevenue = async (req, res) => {
  try {
    const { startDate, endDate, exportType = 'csv', doctorId, departmentId, labTestCode, status } = req.query;

    let startOfDayUTC, endOfDayUTC;
    
    if (startDate && endDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(endDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else if (startDate) {
      startOfDayUTC = new Date(startDate);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC = new Date(startDate);
      endOfDayUTC.setHours(23, 59, 59, 999);
    } else {
      endOfDayUTC = new Date();
      startOfDayUTC = new Date();
      startOfDayUTC.setDate(startOfDayUTC.getDate() - 30);
      startOfDayUTC.setHours(0, 0, 0, 0);
      endOfDayUTC.setHours(23, 59, 59, 999);
    }

    const dateFilter = {
      $or: [
        { created_at: { $gte: startOfDayUTC, $lte: endOfDayUTC } },
        { createdAt: { $gte: startOfDayUTC, $lte: endOfDayUTC } }
      ]
    };

    const pipeline = [
      { $match: { invoice_type: 'Lab Test', ...dateFilter } },
      { $unwind: '$lab_test_items' },
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
          labTestCode: '$lab_test_items.lab_test_code',
          labTestName: '$lab_test_items.lab_test_name',
          labTestRevenue: '$lab_test_items.total_price',
          labTestQuantity: '$lab_test_items.quantity',
          labTestStatus: '$lab_test_items.status',
          doctorId: '$doctor._id',
          doctorName: { $concat: ['$doctor.firstName', ' ', { $ifNull: ['$doctor.lastName', ''] }] },
          isFullTime: '$doctor.isFullTime',
          revenuePercentage: '$doctor.revenuePercentage',
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

    if (labTestCode && labTestCode !== 'all') {
      pipeline.push({ $match: { 'lab_test_items.lab_test_code': labTestCode } });
    }

    if (status && status !== 'all') {
      pipeline.push({ $match: { 'lab_test_items.status': status } });
    }

    const labTestItems = await Invoice.aggregate(pipeline);

    const doctors = await Doctor.find({});
    const doctorsMap = new Map();
    doctors.forEach(doc => {
      doctorsMap.set(doc._id.toString(), doc);
    });

    const exportData = labTestItems.map(item => {
      const doctor = item.doctorId ? doctorsMap.get(item.doctorId.toString()) : null;
      const commissionInfo = calculateDoctorCommission(doctor, item.labTestRevenue || 0, 'Lab Test');
      
      return {
        'Date': item.date,
        'Invoice Ref': item.invoice_number || 'N/A',
        'Lab Test Code': item.labTestCode,
        'Lab Test Name': item.labTestName,
        'Status': item.labTestStatus || 'Pending',
        'Quantity': item.labTestQuantity || 1,
        'Revenue': item.labTestRevenue || 0,
        'Doctor': item.doctorName || 'Unknown',
        'Doctor Type': doctor?.isFullTime ? 'Full-time' : 'Part-time',
        'Commission %': commissionInfo.commissionPercentage,
        'Commission Amount': commissionInfo.commission,
        'Hospital Share': commissionInfo.hospitalShare,
        'Department': item.departmentId || 'Unknown'
      };
    });

    const totalRevenue = exportData.reduce((sum, item) => sum + item.Revenue, 0);
    const totalCommission = exportData.reduce((sum, item) => sum + item['Commission Amount'], 0);
    const totalHospitalShare = exportData.reduce((sum, item) => sum + item['Hospital Share'], 0);

    const summaryRow = {
      'Date': '=== SUMMARY ===',
      'Invoice Ref': '',
      'Lab Test Code': '',
      'Lab Test Name': '',
      'Status': '',
      'Quantity': exportData.length,
      'Revenue': totalRevenue,
      'Doctor': '',
      'Doctor Type': '',
      'Commission %': '',
      'Commission Amount': totalCommission,
      'Hospital Share': totalHospitalShare,
      'Department': ''
    };

    exportData.unshift(summaryRow);

    if (exportType === 'excel') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Lab Test Revenue');
      
      const headers = Object.keys(exportData[0]);
      worksheet.columns = headers.map(header => ({
        header: header,
        key: header,
        width: header.includes('Name') ? 30 : 15
      }));

      exportData.forEach(row => {
        worksheet.addRow(row);
      });

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(2).font = { bold: true };

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=labtest_revenue_${startDate || 'all'}_to_${endDate || 'now'}.xlsx`);
      
      await workbook.xlsx.write(res);
      res.end();
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
      res.setHeader('Content-Disposition', `attachment; filename=labtest_revenue_${startDate || 'all'}_to_${endDate || 'now'}.csv`);
      return res.send(csvContent);
    }
  } catch (error) {
    console.error('Error exporting lab test revenue:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = exports;