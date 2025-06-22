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

// Register
exports.registerUser = async (req, res) => {
  try {
    const {
      name, email, password, role,
      hospitalID, registryNo, address, contact,
      policyDetails, healthBima, additionalInfo
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
