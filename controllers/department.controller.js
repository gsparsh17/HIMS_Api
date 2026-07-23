const Department = require('../models/Department');
const Doctor = require('../models/Doctor');
const { requireHospitalId } = require('../services/tenantScope.service');

function fail(res, error, status = 500) {
  return res.status(error.statusCode || status).json({ error: error.message });
}

exports.createDepartment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    if (req.body.head_doctor_id) {
      const exists = await Doctor.exists({
        _id: req.body.head_doctor_id,
        hospitalId
      });

      if (!exists) {
        return res.status(400).json({
          error: 'Head doctor is not in this hospital'
        });
      }
    }

    const dept = await Department.create({
      ...req.body,
      hospitalId
    });

    return res.status(201).json(dept);
  } catch (error) {
    return fail(res, error, 400);
  }
};

exports.getAllDepartments = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const departments = await Department
      .find({
        hospitalId,
        active: { $ne: false }
      })
      .populate('head_doctor_id')
      .sort({ name: 1 });

    return res.json(departments);
  } catch (error) {
    return fail(res, error);
  }
};

exports.getDepartmentById = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const dept = await Department
      .findOne({
        _id: req.params.id,
        hospitalId
      })
      .populate('head_doctor_id');

    if (!dept) {
      return res.status(404).json({
        error: 'Department not found'
      });
    }

    return res.json(dept);
  } catch (error) {
    return fail(res, error);
  }
};

exports.updateDepartment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    if (req.body.head_doctor_id) {
      const exists = await Doctor.exists({
        _id: req.body.head_doctor_id,
        hospitalId
      });

      if (!exists) {
        return res.status(400).json({
          error: 'Head doctor is not in this hospital'
        });
      }
    }

    const dept = await Department.findOneAndUpdate(
      {
        _id: req.params.id,
        hospitalId
      },
      {
        ...req.body,
        hospitalId
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!dept) {
      return res.status(404).json({
        error: 'Department not found'
      });
    }

    return res.json(dept);
  } catch (error) {
    return fail(res, error, 400);
  }
};

exports.deleteDepartment = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const used = await Doctor.exists({
      hospitalId,
      department: req.params.id
    });

    if (used) {
      return res.status(409).json({
        error: 'Department has doctors; deactivate it instead of deleting'
      });
    }

    const dept = await Department.findOneAndDelete({
      _id: req.params.id,
      hospitalId
    });

    if (!dept) {
      return res.status(404).json({
        error: 'Department not found'
      });
    }

    return res.json({ message: 'Department deleted' });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getAllHods = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const rows = await Department
      .find({
        hospitalId,
        head_doctor_id: { $ne: null }
      })
      .populate('head_doctor_id');

    const map = new Map();

    rows.forEach((row) => {
      if (row.head_doctor_id) {
        map.set(String(row.head_doctor_id._id), row.head_doctor_id);
      }
    });

    return res.json([...map.values()]);
  } catch (error) {
    return fail(res, error);
  }
};

exports.getDepartmentIdByName = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const escapedName = String(req.params.name)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const department = await Department.findOne({
      hospitalId,
      name: new RegExp(`^${escapedName}$`, 'i')
    });

    if (!department) {
      return res.status(404).json({
        error: 'Department not found'
      });
    }

    return res.json({
      id: department._id,
      name: department.name
    });
  } catch (error) {
    return fail(res, error);
  }
};

exports.getDepartmentsByHeadDoctor = async (req, res) => {
  try {
    const hospitalId = requireHospitalId(req);

    const departments = await Department.find({
      hospitalId,
      head_doctor_id: req.params.headDoctorId
    });

    return res.json(departments);
  } catch (error) {
    return fail(res, error);
  }
};