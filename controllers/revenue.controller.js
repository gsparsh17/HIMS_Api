const Appointment = require('../models/Appointment');
const Salary = require('../models/Salary');
const Invoice = require('../models/Invoice');
const mongoose = require('mongoose');

// Calculate hospital revenue
exports.calculateHospitalRevenue = async (req, res) => {
  try {
    const { period, startDate, endDate } = req.query;
    
    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else {
      // Default to current month if no dates provided
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      dateFilter.createdAt = {
        $gte: firstDayOfMonth,
        $lte: lastDayOfMonth
      };
    }

    // Calculate revenue from appointments (billing)
    const appointmentRevenue = await Invoice.aggregate([
      {
        $match: {
          ...dateFilter,
          status: 'Paid',
          invoice_type: 'Appointment'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total' },
          appointmentCount: { $sum: 1 }
        }
      }
    ]);

    // Calculate revenue from pharmacy sales
    const pharmacyRevenue = await Invoice.aggregate([
      {
        $match: {
          ...dateFilter,
          status: 'Paid',
          invoice_type: 'Pharmacy'
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total' },
          saleCount: { $sum: 1 }
        }
      }
    ]);

    // Calculate doctor salary expenses
    const salaryExpenses = await Salary.aggregate([
      {
        $match: {
          ...dateFilter,
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

    // Calculate net revenue
    const totalAppointmentRevenue = appointmentRevenue[0]?.totalRevenue || 0;
    const totalPharmacyRevenue = pharmacyRevenue[0]?.totalRevenue || 0;
    const totalSalaryExpenses = salaryExpenses[0]?.totalExpenses || 0;
    
    const grossRevenue = totalAppointmentRevenue + totalPharmacyRevenue;
    const netRevenue = grossRevenue - totalSalaryExpenses;

    res.json({
      period: {
        start: dateFilter.createdAt?.$gte || new Date(),
        end: dateFilter.createdAt?.$lte || new Date()
      },
      revenue: {
        appointment: totalAppointmentRevenue,
        pharmacy: totalPharmacyRevenue,
        gross: grossRevenue,
        net: netRevenue
      },
      expenses: {
        salaries: totalSalaryExpenses
      },
      counts: {
        appointments: appointmentRevenue[0]?.appointmentCount || 0,
        pharmacySales: pharmacyRevenue[0]?.saleCount || 0,
        salariesPaid: salaryExpenses[0]?.salaryCount || 0
      },
      profitability: {
        grossMargin: grossRevenue > 0 ? ((grossRevenue - totalSalaryExpenses) / grossRevenue) * 100 : 0,
        netMargin: grossRevenue > 0 ? (netRevenue / grossRevenue) * 100 : 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get daily revenue report
exports.getDailyRevenueReport = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date();
    
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const [appointmentRevenue, pharmacyRevenue, salaryExpenses] = await Promise.all([
      // Appointment revenue
      Invoice.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            status: 'Paid',
            invoice_type: 'Appointment'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$total' },
            count: { $sum: 1 }
          }
        }
      ]),
      // Pharmacy revenue
      Invoice.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfDay, $lte: endOfDay },
            status: 'Paid',
            invoice_type: 'Pharmacy'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$total' },
            count: { $sum: 1 }
          }
        }
      ]),
      // Salary expenses
      Salary.aggregate([
        {
          $match: {
            paid_date: { $gte: startOfDay, $lte: endOfDay },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$net_amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    const result = {
      date: targetDate.toISOString().split('T')[0],
      revenue: {
        appointment: appointmentRevenue[0]?.total || 0,
        pharmacy: pharmacyRevenue[0]?.total || 0,
        total: (appointmentRevenue[0]?.total || 0) + (pharmacyRevenue[0]?.total || 0)
      },
      expenses: {
        salaries: salaryExpenses[0]?.total || 0
      },
      net: ((appointmentRevenue[0]?.total || 0) + (pharmacyRevenue[0]?.total || 0)) - (salaryExpenses[0]?.total || 0),
      counts: {
        appointments: appointmentRevenue[0]?.count || 0,
        pharmacySales: pharmacyRevenue[0]?.count || 0,
        salariesPaid: salaryExpenses[0]?.count || 0
      }
    };

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get monthly revenue report
exports.getMonthlyRevenueReport = async (req, res) => {
  try {
    const { year, month } = req.query;
    const targetYear = parseInt(year) || new Date().getFullYear();
    const targetMonth = parseInt(month) || new Date().getMonth() + 1;

    const startOfMonth = new Date(targetYear, targetMonth - 1, 1);
    const endOfMonth = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);

    const [revenueByDay, salaryExpenses] = await Promise.all([
      // Daily revenue breakdown
      Invoice.aggregate([
        {
          $match: {
            createdAt: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'Paid'
          }
        },
        {
          $group: {
            _id: {
              day: { $dayOfMonth: '$createdAt' },
              type: '$invoice_type'
            },
            total: { $sum: '$total' },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.day': 1 } }
      ]),
      // Monthly salary expenses
      Salary.aggregate([
        {
          $match: {
            period_start: { $gte: startOfMonth, $lte: endOfMonth },
            status: 'paid'
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$net_amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    // Process daily revenue data
    const dailyBreakdown = {};
    revenueByDay.forEach(item => {
      const day = item._id.day;
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = { appointment: 0, pharmacy: 0, total: 0 };
      }
      dailyBreakdown[day][item._id.type.toLowerCase()] = item.total;
      dailyBreakdown[day].total += item.total;
    });

    res.json({
      month: targetMonth,
      year: targetYear,
      dailyBreakdown,
      salaryExpenses: salaryExpenses[0]?.total || 0,
      totalRevenue: Object.values(dailyBreakdown).reduce((sum, day) => sum + day.total, 0),
      netRevenue: Object.values(dailyBreakdown).reduce((sum, day) => sum + day.total, 0) - (salaryExpenses[0]?.total || 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};