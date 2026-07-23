const StaffAttendance = require('../models/StaffAttendance');
const AttendancePunch = require('../models/AttendancePunch');

function dayBounds(value) {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return { start, end };
}

async function reconcileEmployeeDay({ hospitalId, employeeId, date, actorUserId }) {
  const { start, end } = dayBounds(date);

  const punches = await AttendancePunch
    .find({
      hospitalId,
      employeeId,
      timestamp: { $gte: start, $lt: end },
      validationStatus: { $in: ['valid', 'reconciled', 'exception'] }
    })
    .sort({ timestamp: 1 });

  if (!punches.length) return null;

  const first = punches.find((p) => p.direction !== 'out') || punches[0];
  const last = [...punches]
    .reverse()
    .find((p) => p.direction !== 'in') ||
    (punches.length > 1 ? punches[punches.length - 1] : null);

  const exceptions = [];

  if (!last || last._id.equals(first._id)) {
    exceptions.push('missing_checkout');
  }

  const totalMinutes = last
    ? Math.max(0, Math.round((last.timestamp - first.timestamp) / 60000))
    : 0;

  const attendance = await StaffAttendance.findOneAndUpdate(
    {
      hospital_id: hospitalId,
      employee_id: employeeId,
      attendance_date: start
    },
    {
      $set: {
        check_in: first.timestamp,
        check_out: last?.timestamp,
        total_minutes: totalMinutes,
        status: exceptions.length ? 'present' : 'present',
        attendance_source: 'biometric',
        updated_by: actorUserId,
        reconciliation_status: exceptions.length ? 'exception' : 'reconciled',
        reconciliation_exceptions: exceptions
      },
      $setOnInsert: {
        hospital_id: hospitalId,
        employee_id: employeeId,
        attendance_date: start,
        created_by: actorUserId
      }
    },
    {
      upsert: true,
      new: true,
      runValidators: true
    }
  );

  await AttendancePunch.updateMany(
    { _id: { $in: punches.map((p) => p._id) } },
    {
      $set: {
        validationStatus: exceptions.length ? 'exception' : 'reconciled',
        reconciledAttendanceId: attendance._id
      }
    }
  );

  return attendance;
}

async function reconcilePunches({ hospitalId, employeeIds, from, to, actorUserId }) {
  const start = from ? new Date(from) : new Date();
  start.setHours(0, 0, 0, 0);

  const end = to ? new Date(to) : new Date(start);
  if (!to) {
    end.setDate(end.getDate() + 1);
  } else {
    end.setHours(23, 59, 59, 999);
  }

  const filter = {
    hospitalId,
    timestamp: { $gte: start, $lte: end },
    employeeId: { $ne: null }
  };

  if (employeeIds?.length) {
    filter.employeeId = { $in: employeeIds };
  }

  const punchGroups = await AttendancePunch.aggregate([
    { $match: filter },
    {
      $group: {
        _id: {
          employeeId: '$employeeId',
          day: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$timestamp',
              timezone: 'Asia/Kolkata'
            }
          }
        }
      }
    }
  ]);

  const results = [];

  for (const group of punchGroups) {
    results.push(
      await reconcileEmployeeDay({
        hospitalId,
        employeeId: group._id.employeeId,
        date: group._id.day,
        actorUserId
      })
    );
  }

  return results.filter(Boolean);
}

module.exports = {
  reconcileEmployeeDay,
  reconcilePunches
};