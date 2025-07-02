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
      fireNOC
    } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists) return res.status(400).json({ message: 'User already exists' });

    const user = await User.create({ name, email, password, role });

    // Only if the role is 'admin', create hospital entry
    if (role === 'admin') {
      try{
      await Hospital.create({
        hospitalID,
        registryNo,
        name,
        address,
        contact,
        email,
        fireNOC,
        policyDetails,
        healthBima,
        additionalInfo,
        createdBy: user._id
      });
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
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (user && await user.matchPassword(password)) {
      res.json({
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        token: generateToken(user._id, user.role)
      });
    } else {
      res.status(401).json({ error: 'Invalid email or password' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
