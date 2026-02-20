// const User = require('../models/User');
// const generateToken = require('../utils/generateToken');

// Register
// exports.registerUser = async (req, res) => {
//   try {
//     const { name, email, password, role } = req.body;
//     const userExists = await User.findOne({ email });
//     if (userExists) return res.status(400).json({ error: 'User already exists' });

//     const user = await User.create({ name, email, password, role });
//     res.status(201).json({
//       _id: user._id,
//       name: user.name,
//       email: user.email,
//       role: user.role,
//       token: generateToken(user._id, user.role)
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

const User = require('../models/User');
const Hospital = require('../models/Hospital'); // <- import
const generateToken = require('../utils/generateToken');
const crypto = require('crypto');
const sendEmail = require('../utils/sendEmail'); // We'll create this
const Doctor = require('../models/Doctor');
const Staff = require('../models/Staff');
const Pharmacy = require('../models/Pharmacy');
const Department = require('../models/Department');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const PathologyStaff = require('../models/PathologyStaff');

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

    // Generate token
    const resetToken = crypto.randomBytes(20).toString('hex');

    // Hash token & set expire time
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpire = Date.now() + 15 * 60 * 1000; // 15 minutes

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

// Register
exports.registerUser = async (req, res) => {
  try {
    const {
      name, email, password, role,
      hospitalID, registryNo, address, contact,
      policyDetails, healthBima, additionalInfo,
      fireNOC, hospitalName, companyName, companyNumber, state, city, pincode
    } = req.body;

    let logoUrl = null;
    if (req.file) {
      try {
        const result = await cloudinary.uploader.upload(req.file.path, {
          folder: 'hospital_logos',
          resource_type: 'image'
        });
        logoUrl = result.secure_url;
        fs.unlinkSync(req.file.path); // Clean up local file
      } catch (uploadErr) {
        console.error('Logo Upload Error:', uploadErr);
      }
    }

    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    const user = await User.create({ name, email, password, role });

    // Only if the role is 'admin', create hospital entry
    if (role === 'admin') {
      try{
      await Hospital.create({
      hospitalID,
      registryNo,
      hospitalName, // ✅ Updated
      companyName,
      companyNumber,
      state,
      city,
      pincode,
      name, // Contact person name
      address,
      contact,
      email,
      fireNOC, // optional during initial creation
      policyDetails,
      healthBima,
      additionalInfo,
      additionalInfo,
      logo: logoUrl,
      createdBy: user._id
    });

    await Department.create({
      name: "Administration"
    })
    await Department.create({
      name: "Emergency Department (ED/ER)"
    })

    }
  catch (hospitalErr) {
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


// Login
// controllers/userController.js - Update the login function

// Login
// controllers/userController.js - Login function with pathology_staff support

// Login
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    const hospital = await Hospital.findOne({});
    
    if (user && await user.matchPassword(password)) {
      
      if(user.role === "doctor") {
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
      else if(user.role === "staff" || user.role === "registrar" || user.role === "receptionist") {
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
      else if(user.role === "nurse") {
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
      else if(user.role === "pharmacy") {
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
      else if(user.role === "pathology_staff") {
        const pathologyStaff = await PathologyStaff.findOne({ email });
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
