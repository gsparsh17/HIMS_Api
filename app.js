const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/patients', require('./routes/patient.routes'));
app.use('/api/doctors', require('./routes/doctor.routes'));
app.use('/api/nurses', require('./routes/nurse.routes'));
app.use('/api/staff', require('./routes/staff.routes'));
app.use('/api/appointments', require('./routes/appointment.routes'));
app.use('/api/pharmacy', require('./routes/pharmacy.routes'));
app.use('/api/prescriptions', require('./routes/prescription.routes'));
app.use('/api/billing', require('./routes/billing.routes'));
app.use('/api/departments', require('./routes/department.routes'));
app.use('/api/rooms', require('./routes/room.routes'));
app.use('/api/shifts', require('./routes/shift.routes'));
app.use('/api/labreports', require('./routes/labreport.routes'));
app.use('/api/hospitals', require('./routes/hospital.routes'));
app.use('/api/hospital-charges', require('./routes/hospitalcharges.routes'));


// 404 route handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

module.exports = app;
