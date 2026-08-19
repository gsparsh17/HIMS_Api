const Nurse = require('../models/Nurse');
const User = require('../models/User');
const HRStaffProfile = require('../models/HRStaffProfile');
const { requireHospitalId } = require('../services/tenantScope.service');

const scoped = (req, extra = {}) => ({ hospitalId: requireHospitalId(req), ...extra });

exports.createNurse = async (req, res) => {
  try {
    const nurse = await Nurse.create({ ...req.body, hospitalId: requireHospitalId(req) });
    res.status(201).json(nurse);
  } catch (err) { res.status(400).json({ error: err.message }); }
};

exports.getAllNurses = async (req, res) => {
  try {
    const nurses = await Nurse.find(scoped(req, { is_active: { $ne: false } }))
      .populate('department_id').populate('shift_id');
    res.json(nurses);
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
    delete req.body.hospitalId;
    const nurse = await Nurse.findOneAndUpdate(scoped(req, { _id: req.params.id, is_active: { $ne: false } }), req.body, { new: true, runValidators: true });
    if (!nurse) return res.status(404).json({ error: 'Nurse not found' });
    res.json(nurse);
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
