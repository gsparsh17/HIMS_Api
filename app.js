// const express = require('express');
// const cors = require('cors');
// const morgan = require('morgan');
// const app = express();

// const Customer = require('./models/Customer');
// const Medicine = require('./models/Medicine');


// // Middleware
// app.use(cors());
// app.use(express.json());
// app.use(morgan('dev'));



// // Routes
// app.use('/api/auth', require('./routes/auth.routes'));
// app.use('/api/patients', require('./routes/patient.routes'));
// app.use('/api/doctors', require('./routes/doctor.routes'));
// app.use('/api/nurses', require('./routes/nurse.routes'));
// app.use('/api/staff', require('./routes/staff.routes'));
// app.use('/api/appointments', require('./routes/appointment.routes'));
// app.use('/api/pharmacy', require('./routes/pharmacy.routes'));
// app.use('/api/prescriptions', require('./routes/prescription.routes'));
// app.use('/api/billing', require('./routes/billing.routes'));
// app.use('/api/departments', require('./routes/department.routes'));
// app.use('/api/rooms', require('./routes/room.routes'));
// app.use('/api/shifts', require('./routes/shift.routes'));
// app.use('/api/labreports', require('./routes/labreport.routes'));
// app.use('/api/hospitals', require('./routes/hospital.routes'));
// app.use('/api/hospital-charges', require('./routes/hospitalcharges.routes'));
// app.use('/api/calendar', require('./routes/calendar.routes'));
// // app.use('/api/customers', require('./routes/customer.routes.js'));

// const customerRoutes = require('./routes/customer.routes.js')(Customer, Medicine);
// app.use('/api/customers', customerRoutes);

// const updateCalendar = require('./jobs/calendarJob');
// updateCalendar(); // Run once on server start


// // 404 route handler
// app.use((req, res, next) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Global error handler
// app.use((err, req, res, next) => {
//   console.error(err.stack);
//   res.status(500).json({ error: 'Something went wrong!' });
// });

// module.exports = app;









// const express = require('express');
// const cors = require('cors');
// const morgan = require('morgan');
// const app = express();

// // --- IMPORTANT: Pre-load all Mongoose models here ---
// require('./models/Customer');
// require('./models/Medicine');
// require('./models/Doctor');
// require('./models/Patient');
// require('./models/Prescription');
// require('./models/Invoice');
// // ... add a require for every model file you have

// // Middleware
// app.use(cors());
// app.use(express.json());
// app.use(morgan('dev'));

// // Routes
// app.use('/api/auth', require('./routes/auth.routes'));
// app.use('/api/patients', require('./routes/patient.routes'));
// app.use('/api/doctors', require('./routes/doctor.routes'));
// app.use('/api/nurses', require('./routes/nurse.routes'));
// app.use('/api/staff', require('./routes/staff.routes'));
// app.use('/api/appointments', require('./routes/appointment.routes'));
// app.use('/api/pharmacy', require('./routes/pharmacy.routes'));
// app.use('/api/prescriptions', require('./routes/prescription.routes'));
// app.use('/api/billing', require('./routes/billing.routes'));
// app.use('/api/departments', require('./routes/department.routes'));
// app.use('/api/rooms', require('./routes/room.routes'));
// app.use('/api/shifts', require('./routes/shift.routes'));
// app.use('/api/labreports', require('./routes/labreport.routes'));
// app.use('/api/hospitals', require('./routes/hospital.routes'));
// app.use('/api/hospital-charges', require('./routes/hospitalcharges.routes'));
// app.use('/api/calendar', require('./routes/calendar.routes'));
// app.use('/api/customers', require('./routes/customer.routes.js')); // Your customer route
// app.use('/api/billing', require('./routes/billing.routes.js'));

// const updateCalendar = require('./jobs/calendarJob');
// updateCalendar();

// // Error Handlers
// app.use((req, res, next) => {
//   res.status(404).json({ error: 'Route not found' });
// });
// app.use((err, req, res, next) => {
//   console.error(err.stack);
//   res.status(500).json({ error: 'Something went wrong!' });
// });

// module.exports = app;



const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const app = express();

// --- IMPORTANT: Pre-load all Mongoose models here ---
require('./models/Customer');
require('./models/Medicine');
require('./models/Doctor');
require('./models/Patient');
require('./models/Prescription');
require('./models/pharmacyInvoiceModel.js');
require('./models/Supplier.js'); // ADDED: Pre-load the Supplier model
// ... add a require for every model file you have

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Routes
// In your main server.js or app.js
const paymentRoutes = require('./routes/paymentRoutes'); // Make sure path is correct

// This line combines the prefix with the specific route
app.use('/api/payments', paymentRoutes); // <-- Check this line carefully!
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/patients', require('./routes/patient.routes'));
app.use('/api/doctors', require('./routes/doctor.routes'));
app.use('/api/nurses', require('./routes/nurse.routes'));
app.use('/api/staff', require('./routes/staff.routes'));
app.use('/api/appointments', require('./routes/appointment.routes'));
// app.use('/api/pharmacy', require('./routes/pharmacy.routes'));
app.use('/api/prescriptions', require('./routes/prescription.routes'));
app.use('/api/procedures', routes('./routes/procedureRoutes'));
app.use('/api/NLEMmedicines', require('/routes/NLEMmedicineRoutes'));
app.use('/api/billing', require('./routes/billing.routes'));
app.use('/api/departments', require('./routes/department.routes'));
app.use('/api/rooms', require('./routes/room.routes'));
app.use('/api/shifts', require('./routes/shift.routes'));
app.use('/api/labreports', require('./routes/labreport.routes'));
app.use('/api/hospitals', require('./routes/hospital.routes'));
app.use('/api/hospital-charges', require('./routes/hospitalcharges.routes'));
app.use('/api/calendar', require('./routes/calendar.routes'));
app.use('/api/customers', require('./routes/customer.routes.js'));
app.use('/api/suppliers', require('./routes/supplierRoutes.js')); // ADDED: Mount the supplier routes
const medicineRoutes = require('./routes/medicine.routes');
const batchRoutes = require('./routes/batch.routes');
const stockAdjustmentRoutes = require('./routes/stockAdjustment.routes');
const orderRoutes = require('./routes/order.routes');
const pharmacyRoutes = require('./routes/pharmacy.routes');
const invoiceRoutes = require('./routes/invoice.routes');
const salaryRoutes = require('./routes/salary.routes');
const revenueRoutes = require('./routes/revenue.routes');
const cronJobs = require('./jobs/jobs');
const { updateCalendar } = require('./jobs/calendarJob.js');

app.use('/api/salaries', salaryRoutes);
app.use('/api/revenue', revenueRoutes);

// Mount routes
app.use('/api/medicines', medicineRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api/stock-adjustments', stockAdjustmentRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/invoices', invoiceRoutes);

updateCalendar();

// Error Handlers
app.use((req, res, next) => {
  res.status(404).json({ error: 'Route not found' });
});
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

module.exports = app;










