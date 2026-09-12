const Nurse = require('../models/Nurse');
const User = require('../models/User');
const HRStaffProfile = require('../models/HRStaffProfile');
const { requireHospitalId } = require('../services/tenantScope.service');
const { syncHRProfileFromSource } = require('../services/hrProfileSync.service');
const staffScheduleService = require('../services/staffSchedule.service');
const StaffSchedule = require('../models/StaffSchedule');

const scoped = (req, extra = {}) => ({ hospitalId: requireHospitalId(req), ...extra });

exports.createNurse = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const weeklySchedule = req.body.weekly_schedule || req.body.weeklySchedule;
    const payload = { ...req.body, hospitalId };
    delete payload.weekly_schedule;
    delete payload.weeklySchedule;
    const nurse = await Nurse.create(payload);
    const profile = await syncHRProfileFromSource('Nurse', nurse, { hospital_id: hospitalId });
    if (profile && Array.isArray(weeklySchedule) && weeklySchedule.some((day) => day?.enabled && day?.intervals?.length)) {
      await staffScheduleService.upsertScheduleForEmployee({ hospitalId, employeeId: profile._id, weekly: weeklySchedule, userId: req.user?._id });
    }
    res.status(201).json(nurse);
  } catch (err) { res.status(400).json({ error: err.message }); }
};

exports.getAllNurses = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const nurses = await Nurse.find({ hospitalId, is_active: { $ne: false } })
      .populate('department_id').populate('shift_id');
    const profiles = await HRStaffProfile.find({ hospital_id: hospitalId, nurse_id: { $in: nurses.map((row) => row._id) } }).select('_id nurse_id').lean();
    const schedules = await StaffSchedule.find({ hospital_id: hospitalId, employee_id: { $in: profiles.map((row) => row._id) }, is_active: true }).lean();
    const profileByNurse = new Map(profiles.map((row) => [String(row.nurse_id), String(row._id)]));
    const scheduleByEmployee = new Map(schedules.map((row) => [String(row.employee_id), row.weekly]));
    res.json(nurses.map((nurse) => ({ ...nurse.toObject(), weekly_schedule: scheduleByEmployee.get(profileByNurse.get(String(nurse._id))) || null })));
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
};

exports.getNurseById = async (req, res) => {
  try {
    const nurse = await Nurse.findOne(scoped(req, { _id: req.params.id, is_active: { $ne: false } }))
      .populate('department_id').populate('shift_id');
    if (!nurse) return res.status(404).json({ error: 'Nurse not found' });
    res.json(nurse);
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
};

exports.updateNurse = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const weeklySchedule = req.body.weekly_schedule || req.body.weeklySchedule;
    const payload = { ...req.body };
    delete payload.hospitalId;
    delete payload.weekly_schedule;
    delete payload.weeklySchedule;
    const nurse = await Nurse.findOneAndUpdate({ hospitalId, _id: req.params.id, is_active: { $ne: false } }, payload, { new: true, runValidators: true });
    if (!nurse) return res.status(404).json({ error: 'Nurse not found' });
    const profile = await syncHRProfileFromSource('Nurse', nurse, { hospital_id: hospitalId });
    let schedule = null;
    if (profile && Array.isArray(weeklySchedule)) {
      schedule = await staffScheduleService.upsertScheduleForEmployee({ hospitalId, employeeId: profile._id, weekly: weeklySchedule, userId: req.user?._id });
    }
    res.json({ ...nurse.toObject(), weekly_schedule: schedule?.weekly || undefined });
  } catch (err) { res.status(err.statusCode || 400).json({ error: err.message }); }
};

exports.deleteNurse = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);
    const nurse = await Nurse.findOne({ _id: req.params.id, hospitalId, is_active: { $ne: false } });
    if (!nurse) return res.status(404).json({ error: 'Nurse not found' });
    const now = new Date();
    const reason = String(req.body?.reason || 'Deactivated from nurse administration').trim();
    Object.assign(nurse, { is_active: false, deleted_at: now, deleted_by: req.user?._id || null, deletion_reason: reason });
    await nurse.save();
    const profiles = await HRStaffProfile.find({ hospital_id: hospitalId, nurse_id: nurse._id }).select('user_id');
    const userIds = profiles.map(p => p.user_id).filter(Boolean);
    await HRStaffProfile.updateMany({ hospital_id: hospitalId, nurse_id: nurse._id }, { $set: { is_active: false, employment_status: 'Inactive', login_enabled: false, deleted_at: now, deleted_by: req.user?._id || null, deletion_reason: reason } });
    if (userIds.length) await User.updateMany({ _id: { $in: userIds }, hospital_id: hospitalId }, { $set: { is_active: false, deleted_at: now, deleted_by: req.user?._id || null, deletion_reason: reason } });
    res.json({ message: 'Nurse deactivated successfully', nurse });
  } catch (err) { res.status(err.statusCode || 500).json({ error: err.message }); }
};
