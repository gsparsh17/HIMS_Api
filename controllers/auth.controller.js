const User = require('../models/User');
const Hospital = require('../models/Hospital');
const generateToken = require('../utils/generateToken');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail');
const Doctor = require('../models/Doctor');
const Staff = require('../models/Staff');
const Pharmacy = require('../models/Pharmacy');
const Department = require('../models/Department');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const PathologyStaff = require('../models/PathologyStaff');
const OTStaff = require('../models/OTStaff'); // Add OT Staff model
const HRStaffProfile = require('../models/HRStaffProfile');
const jwt = require('jsonwebtoken');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const resetToken = crypto.randomBytes(20).toString('hex');

    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpire = Date.now() + 15 * 60 * 1000;

    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    const message = `You (or someone else) requested to reset your password. Click the link below to reset it:\n\n${resetUrl}`;

    await sendEmail({
      to: user.email,
      subject: 'Password Reset Request',
      text: message
    });

    res.status(200).json({ message: 'Reset link sent to email' });
  } catch (err) {
    console.error('Forgot Password Error:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.demoLogin = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required - Invalid authorization header format' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required - Token missing' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      console.error('JWT Verification Error:', jwtError);
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token format' });
      }
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }
      throw jwtError;
    }

    if (!decoded || !decoded.id) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    const demoUser = await User.findById(decoded.id);
    if (!demoUser) {
      return res.status(403).json({ error: 'User not found' });
    }

    const targetUser = await User.findOne({ email });
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hospital = await Hospital.findOne({});

    const newToken = generateToken(targetUser._id, targetUser.role);

    let response = {
      _id: targetUser._id,
      name: targetUser.name,
      email: targetUser.email,
      role: targetUser.role,
      token: newToken,
      hospitalID: hospital?._id,
      isDemoLogin: true,
      originalDemoUser: {
        id: demoUser._id,
        name: demoUser.name,
        email: demoUser.email
      }
    };

    try {
      if (targetUser.role === "doctor") {
        const doctor = await Doctor.findOne({ email: targetUser.email });
        response.doctorId = doctor?._id;
      }
      else if (["staff", "registrar", "receptionist"].includes(targetUser.role)) {
        const staff = await Staff.findOne({ email: targetUser.email });
        response.staffId = staff?._id;
      }
      else if (targetUser.role === "nurse") {
        const nurse = await Staff.findOne({ email: targetUser.email });
        response.staffId = nurse?._id;
      }
      else if (["hr", "hr_manager", "store", "store_manager", "inventory_manager", "accountant", "equipment_manager"].includes(targetUser.role)) {
        const hrProfile = await HRStaffProfile.findOne({ email: targetUser.email });
        response.employeeId = hrProfile?._id;
        response.employeeCode = hrProfile?.employee_code;
        response.dashboard = ["store", "store_manager", "inventory_manager"].includes(targetUser.role) ? "store" : ["hr", "hr_manager"].includes(targetUser.role) ? "hr" : "equipment";
      }
      else if (targetUser.role === "pharmacy") {
        const pharmacy = await Pharmacy.findOne({ email: targetUser.email });
        response.pharmacyId = pharmacy?._id;
      }
      else if (targetUser.role === "pathology_staff") {
        const pathologyStaff = await PathologyStaff.findOne({ email: targetUser.email });
        response.pathologyStaffId = pathologyStaff?._id;
      }
      else if (targetUser.role === "ot_staff") {
        const otStaff = await OTStaff.findOne({ userId: targetUser._id });
        response.otStaffId = otStaff?._id;
      }
    } catch (roleError) {
      console.error('Error fetching role-specific data:', roleError);
    }

    res.json(response);

  } catch (err) {
    console.error('Demo Login error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.resetPassword = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() }
    });

    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;

    await user.save();

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.registerUser = async (req, res) => {
  try {
    const {
      name, email, password, role, registryNo, address, contact,
      policyDetails, healthBima, additionalInfo,
      fireNOC, hospitalName, companyName, licenseNumber, state, city, pincode
    } = req.body;

    let logoUrl = null;
    if (req.file) {
      try {
        const result = await cloudinary.uploader.upload(req.file.path, {
          folder: 'hospital_logos',
          resource_type: 'image'
        });
        logoUrl = result.secure_url;
        fs.unlinkSync(req.file.path);
      } catch (uploadErr) {
        console.error('Logo Upload Error:', uploadErr);
      }
    }

    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    const user = await User.create({ name, email, password, role });

    if (role === 'admin') {
      try {
        const hospital = new Hospital({
          registryNo,
          hospitalName,
          companyName,
          licenseNumber,
          state,
          city,
          pinCode: pincode,
          name,
          address,
          contact,
          email,
          fireNOC,
          policyDetails,
          healthBima,
          additionalInfo,
          logo: logoUrl,
          createdBy: user._id
        });

        await hospital.save({ validateBeforeSave: false });

        await Department.create({ name: "Administration" });
        await Department.create({ name: "Emergency Department" });

      } catch (hospitalErr) {
        console.error('Hospital Creation Error:', hospitalErr);
        return res.status(400).json({ message: 'Hospital creation failed', error: hospitalErr.message });
      }
    }

    res.status(201).json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: generateToken(user._id, user.role)
    });
  } catch (err) {
    console.error('🔴 Registration Error:', err);
    return res.status(500).json({
      message: err?.message || 'Internal Server Error',
      stack: err?.stack
    });
  }
};

// UPDATED LOGIN FUNCTION WITH OT STAFF SUPPORT - FIXED
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    const hospital = await Hospital.findOne({});

    if (user && await user.matchPassword(password)) {

      // Doctor role
      if (user.role === "doctor") {
        const doctor = await Doctor.findOne({ email });
        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id,
          doctorId: doctor?._id
        });
      }

      // Staff, Registrar, Receptionist roles
      else if (user.role === "staff" || user.role === "registrar" || user.role === "receptionist") {
        const staff = await Staff.findOne({ email });
        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id,
          staffId: staff?._id
        });
      }

      // Nurse role
      else if (user.role === "nurse") {
        const nurse = await Staff.findOne({ email });
        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id,
          staffId: nurse?._id
        });
      }

      else if (["hr", "hr_manager", "store", "store_manager", "inventory_manager", "accountant", "equipment_manager"].includes(user.role)) {
        const hrProfile = await HRStaffProfile.findOne({ email: user.email });
        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id,
          employeeId: hrProfile?._id,
          employeeCode: hrProfile?.employee_code,
          dashboard: ["store", "store_manager", "inventory_manager"].includes(user.role) ? "store" : ["hr", "hr_manager"].includes(user.role) ? "hr" : "equipment"
        });
      }

      // Pharmacy role
      else if (user.role === "pharmacy") {
        const pharmacy = await Pharmacy.findOne({ email });
        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id,
          pharmacyId: pharmacy?._id
        });
      }

      // Pathology Staff role
      else if (user.role === "pathology_staff") {
        const pathologyStaff = await PathologyStaff.findOne({ email: email });
        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id,
          pathologyStaffId: pathologyStaff?._id
        });
      }

      // OT STAFF ROLE - FIXED: Search by email instead of userId
      else if (user.role === "ot_staff") {
        // Try to find OT Staff by email (since Staff record might have the email)
        let otStaff = await OTStaff.findOne({ userId: user._id });

        // If not found by userId, try to find by email through Staff collection
        if (!otStaff) {
          const staffRecord = await Staff.findOne({ email: user.email });
          if (staffRecord) {
            otStaff = await OTStaff.findOne({ userId: staffRecord._id });
          }
        }

        // If still not found, try to find by employeeId pattern
        if (!otStaff) {
          otStaff = await OTStaff.findOne({ employeeId: { $regex: user.email.split('@')[0], $options: 'i' } });
        }

        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id,
          otStaffId: otStaff?._id || null,
          otStaffDesignation: otStaff?.designation || 'OT Staff'
        });
      }

      // Default/Admin role
      else {
        res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          token: generateToken(user._id, user.role),
          hospitalID: hospital?._id
        });
      }
    } else {
      res.status(401).json({ error: 'Invalid email or password' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
};