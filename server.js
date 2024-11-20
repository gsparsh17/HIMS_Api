const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken'); // For JWT authentication

const app = express();
const port = 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Connect to MongoDB
mongoose.connect('mongodb://localhost:27017/HospitalDashboard', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error(err));

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }, 
  role: { type: String, enum: ['staff', 'admin'], required: true },
});

const User = mongoose.model('User', userSchema);

// Hospital schema
const hospitalSchema = new mongoose.Schema({
  hospitalID: { type: String, required: true, unique: true },
  registryNo: { type: String, required: true },
  name: { type: String, required: true },
  address: { type: String, required: true },
  contact: { type: String, required: true },
  email: { type: String, required: true },
  policyDetails: { type: String },
  healthBima: { type: String },
  additionalInfo: { type: String },
});

const Hospital = mongoose.model('Hospital', hospitalSchema);

app.get('/api/check-hospital-registration', async (req, res) => {
  try {
    const hospital = await Hospital.findOne(); // Adjust query as needed
    if (hospital) {
      return res.json({ registered: true });
    }
    return res.json({ registered: false });
  } catch (error) {
    console.error('Error checking registration status:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/register-hospital', async (req, res) => {
  const {
    hospitalID,
    registryNo,
    name,
    address,
    contact,
    email,
    policyDetails,
    healthBima,
    additionalInfo,
  } = req.body;

  try {
    // Save to the database
    const newHospital = new Hospital({
      hospitalID,
      registryNo,
      name,
      address,
      contact,
      email,
      policyDetails,
      healthBima,
      additionalInfo,
    });

    await newHospital.save();
    res.status(201).send({ message: 'Hospital registered successfully' });
  } catch (error) {
    console.error('Error registering hospital:', error);
    res.status(500).send({ error: 'Failed to register hospital' });
  }
});


// Register route for creating users (admin and staff)
app.post('/api/register', async (req, res) => {
  try {
    const newUser = new User({
      username: req.body.username,
      password: req.body.password, // Storing plain-text password
      role: req.body.role,
    });
    const savedUser = await newUser.save();
    res.status(201).json(savedUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login route
app.post('/api/login', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.body.username });
    if (!user) return res.status(400).json({ error: 'User not found' });

    if (req.body.password !== user.password) return res.status(400).json({ error: 'Invalid password' });

    const token = jwt.sign({ username: user.username, role: user.role }, 'secretKey', { expiresIn: '1h' });
    res.status(200).json({ token, role: user.role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Middleware for authentication
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: 'Access Denied' });

  jwt.verify(token.split(' ')[1], 'secretKey', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid Token' });
    req.user = user;
    next();
  });
};

// Protected routes for staff and admin
app.get('/api/staff-dashboard', authenticateToken, (req, res) => {
  if (req.user.role !== 'staff') return res.status(403).json({ error: 'Access Denied' });
  res.status(200).json({ message: 'Welcome to Staff Dashboard' });
});

app.get('/api/admin-dashboard', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access Denied' });
  res.status(200).json({ message: 'Welcome to Admin Dashboard' });
});

// Doctor schema and routes
const doctorSchema = new mongoose.Schema({
  name: String,
  department: String,
  timing: String,
  availability: String,
  schedule: String,
});

const Doctor = mongoose.model('Doctor', doctorSchema);

app.post('/api/doctors', (req, res) => {
  const newDoctor = new Doctor(req.body);
  newDoctor.save()
    .then((doctor) => res.status(201).json(doctor))
    .catch((err) => res.status(400).json(err));
});

app.get('/api/doctors', (req, res) => {
  Doctor.find()
    .then((doctors) => res.json(doctors))
    .catch((err) => res.status(400).json(err));
});

// Patient schema and routes
const patientSchema = new mongoose.Schema({
  name: String,
  age: Number,
  gender: String,
});

const Patient = mongoose.model('Patient', patientSchema);

app.post('/api/patients', (req, res) => {
  const newPatient = new Patient(req.body);
  newPatient.save()
    .then((patient) => res.status(201).json(patient))
    .catch((err) => res.status(400).json(err));
});

app.get('/api/patients', (req, res) => {
  Patient.find()
    .then((patients) => res.json(patients))
    .catch((err) => res.status(400).json(err));
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
