const CalendarEvent = require('../models/CalendarEvent');
const Doctor = require('../models/Doctor');
const HRStaffProfile = require('../models/HRStaffProfile');
const Hospital = require('../models/Hospital');
const { requireHospitalId } = require('../services/tenantScope.service');
const { DEFAULT_HOSPITAL_TIME_ZONE, hospitalDateKey } = require('../utils/hospitalDateTime');

async function normalizePayload(req) {
  const hospitalId = requireHospitalId(req);
  const hospital = await Hospital.findById(hospitalId).select('timezone').lean();
  const timezone = req.body.timezone || hospital?.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
  const dateKey = hospitalDateKey(req.body.date_key || req.body.date, timezone);
  let employeeId = req.body.employee_id || null;
  const doctorId = req.body.doctor_id || req.body.doctorId || null;
  if (doctorId) {
    const doctor = await Doctor.exists({ _id: doctorId, hospitalId, is_active: { $ne: false } });
    if (!doctor) { const error = new Error('Doctor not found'); error.statusCode = 404; throw error; }
    if (!employeeId) {
      const employee = await HRStaffProfile.findOne({ hospital_id: hospitalId, $or: [{ doctor_id: doctorId }, { source_model: 'Doctor', source_id: doctorId }] }).select('_id').lean();
      employeeId = employee?._id || null;
    }
  }
  return { hospitalId, timezone, dateKey, doctorId, employeeId };
}

exports.list = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const filter = { hospital_id: hospitalId, is_active: { $ne: false } };
    if (req.query.doctor_id) filter.doctor_id = req.query.doctor_id;
    if (req.query.employee_id) filter.employee_id = req.query.employee_id;
    if (req.query.date) filter.date_key = hospitalDateKey(req.query.date, req.query.timezone || DEFAULT_HOSPITAL_TIME_ZONE);
    const events = await CalendarEvent.find(filter).sort({ date_key: 1, start_time: 1 }).lean();
    res.json({ success: true, events });
  } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
};

exports.create = async (req, res) => {
  try {
    const { hospitalId, timezone, dateKey, doctorId, employeeId } = await normalizePayload(req);
    const event = await CalendarEvent.create({
      hospital_id: hospitalId,
      doctor_id: doctorId,
      employee_id: employeeId,
      date_key: dateKey,
      type: req.body.type,
      start_time: req.body.start_time || req.body.startTime,
      end_time: req.body.end_time || req.body.endTime,
      timezone,
      reason: req.body.reason,
      created_by: req.user?._id,
      updated_by: req.user?._id
    });
    res.status(201).json({ success: true, event });
  } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
};

exports.remove = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const event = await CalendarEvent.findOneAndUpdate(
      { _id: req.params.id, hospital_id: hospitalId, is_active: { $ne: false } },
      { $set: { is_active: false, deleted_at: new Date(), deleted_by: req.user?._id, deletion_reason: req.body?.reason || 'Calendar event removed' } },
      { new: true }
    );
    if (!event) return res.status(404).json({ error: 'Calendar event not found' });
    res.json({ success: true, event });
  } catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
};
