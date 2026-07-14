const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const abdmConfig = require('./config/abdm.config');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

function allowedOrigins() {
  const configured = String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured;
}

const origins = allowedOrigins();
app.use(
  cors({
    origin(origin, callback) {
      // Server-to-server requests do not send an Origin header.
      if (!origin || origins.length === 0 || origins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true
  })
);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 600),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/v3')
});
app.use('/api', generalLimiter);

app.get('/health', (req, res) => {
  res.json({
    success: true,
    appRole: abdmConfig.appRole,
    abdmEnvironment: abdmConfig.environment,
    timestamp: new Date().toISOString()
  });
});

function preloadHospitalModels() {
  [
    './models/Customer',
    './models/Medicine',
    './models/Doctor',
    './models/Patient',
    './models/Prescription',
    './models/pharmacyInvoiceModel.js',
    './models/HospitalPharmacySetting',
    './models/PatientAdvanceLedger',
    './models/PharmacyLedgerSettlement',
    './models/PatientSettlementCredit',
    './models/PharmacyLedgerEntry',
    './models/InventoryLedger',
    './models/IPDPatientMedicineStock',
    './models/PharmacyReturn',
    './models/Supplier.js',
    './models/AuditLog.js',
    './models/StaffLeaveRequest',
    './models/StaffAvailability',
    './models/StaffAttendance',
    './models/HRStaffProfile',
    './models/StoreRequisition',
    './models/StoreIssue',
    './models/StorePurchaseOrder',
    './models/StoreInventoryTransaction',
    './models/StoreItem',
    './models/StoreCategory',
    './models/EHRBundle',
    './models/ApprovalRequest',
    './models/FinancialSequence',
    './models/FinancialTransaction',
    './models/BillingServiceMaster',
    './models/BulkImportJob',
    './models/IPDNursingAdmissionAssessment',
    './models/AbdmCareContext',
    './models/AbdmCounterSequence',
    './models/AbdmLinkAuthentication',
    './models/Immunization',
    './models/ClinicalDocument'
  ].forEach((modelPath) => require(modelPath));
}

function mountHospitalRoutes() {
  preloadHospitalModels();
  const auditLogger = require('./middlewares/auditLogger');
  app.use(auditLogger({ apiPrefix: '/api' }));

  app.use('/api/payments', require('./routes/paymentRoutes'));
  app.use('/api/auth', require('./routes/auth.routes'));
  app.use('/api/imports', require('./routes/bulkImport.routes.js'));
  app.use('/api/clinical-ai', require('./routes/clinicalAi.routes.js'));
  app.use('/api/audit-logs', require('./routes/auditLog.routes'));
  app.use('/api/patients', require('./routes/patient.routes'));
  if (abdmConfig.featureM1) app.use('/api/abha', require('./routes/abha.routes'));
  app.use('/api/doctors', require('./routes/doctor.routes'));
  app.use('/api/nurses', require('./routes/nurse.routes'));
  app.use('/api/staff', require('./routes/staff.routes'));
  app.use('/api/insurance-providers', require('./routes/insuranceProvider.routes'));
  app.use('/api/appointments', require('./routes/appointment.routes'));
  app.use('/api/store', require('./routes/store.routes'));
  app.use('/api/hr', require('./routes/hr.routes'));
  app.use('/api/prescriptions', require('./routes/prescription.routes'));
  app.use('/api/procedurerequests', require('./routes/procedureRequest.routes'));
  app.use('/api/procedures', require('./routes/procedureRoutes'));
  app.use('/api/NLEMmedicines', require('./routes/NLEMmedicineRoutes'));
  app.use('/api/billing', require('./routes/billing.routes'));
  app.use('/api/departments', require('./routes/department.routes'));
  app.use('/api/rooms', require('./routes/room.routes'));
  app.use('/api/shifts', require('./routes/shift.routes'));
  app.use('/api/expenses', require('./routes/expense.routes'));
  app.use('/api/labreports', require('./routes/labreport.routes'));
  app.use('/api/hospitals', require('./routes/hospital.routes'));
  app.use('/api/hospital-charges', require('./routes/hospitalcharges.routes'));
  app.use('/api/calendar', require('./routes/calendar.routes'));
  app.use('/api/customers', require('./routes/customer.routes.js'));
  app.use('/api/suppliers', require('./routes/supplierRoutes.js'));
  app.use('/api/episodes', require('./routes/episode.routes.js'));
  app.use('/api/ipd', require('./routes/ipd.routes'));
  app.use('/api/wards', require('./routes/ward.routes'));
  app.use('/api/admin/backups', require('./routes/backup.routes'));
  app.use('/api/salaries', require('./routes/salary.routes'));
  app.use('/api/revenue', require('./routes/revenue.routes'));
  app.use('/api/finance', require('./routes/finance.routes.js'));
  app.use('/api/medicines', require('./routes/medicine.routes'));
  app.use('/api/batches', require('./routes/batch.routes'));
  app.use('/api/stock-adjustments', require('./routes/stockAdjustment.routes'));
  app.use('/api/orders', require('./routes/order.routes'));
  app.use('/api/pharmacy', require('./routes/pharmacy.routes'));
  app.use('/api/invoices', require('./routes/invoice.routes'));
  app.use('/api/pathology-staff', require('./routes/pathologyStaff.routes'));
  app.use('/api/labtests', require('./routes/labTest.routes.js'));
  app.use('/api/lab', require('./routes/lab.routes.js'));
  app.use('/api/radiology', require('./routes/radiology.routes.js'));
  app.use('/api/pharmacy-bills', require('./routes/pharmacyBill.routes'));
  app.use('/api/email', require('./routes/emailRoutes.js'));
  app.use('/api/external-lab', require('./routes/externalLab.routes'));
  app.use('/api/license', require('./routes/license.routes.js'));
  app.use('/api/icd11', require('./routes/icd11.routes.js'));
  app.use('/api/ot', require('./routes/ot.routes.js'));
  app.use('/api/approvals', require('./routes/approval.routes.js'));
  app.use('/api', require('./routes/userAccess.routes'));

  if (abdmConfig.featureM2) {
    // Public users never call this route directly; it is HMAC-authenticated from the ABDM Master.
    app.use('/internal/abdm', (req, res, next) => {
      // If we are in local sandbox mode and both are mounted, avoid middleware collisions
      if (['/facility-status', '/proxy/abha', '/hip/action'].includes(req.path) && abdmConfig.isMaster) {
        return require('./routes/abdmInternal.routes')(req, res, next);
      }
      return require('./routes/abdmConnector.routes')(req, res, next);
    });
    // Authenticated hospital-user endpoints for care contexts, HIP linking and FHIR generation.
    app.use('/api/abdm', require('./routes/abdmHospital.routes'));
  }
}

function preloadMasterModels() {
  [
    './models/AbdmFacility',
    './models/AbdmTransaction',
    './models/AbdmWebhookEvent',
    './models/AbdmConsent',
    './models/AbdmJob'
  ].forEach((modelPath) => require(modelPath));
}

function mountMasterRoutes() {
  preloadMasterModels();

  // The central deployment also serves the MediQliq super-admin control plane.
  // Audit logging is scoped to this route so ABDM callback payloads are not copied into general audit logs.
  const auditLogger = require('./middlewares/auditLogger');
  app.use(
    '/api/mediqliq',
    auditLogger({ apiPrefix: '/api/mediqliq' }),
    require('./routes/mediqliqSuperAdmin.routes')
  );

  // Hospital server -> central master, authenticated using per-facility HMAC connector credentials.
  // app.use('/internal/abdm', require('./routes/abdmInternal.routes')); // Handled by conditional router above
  // MediQliq operations/admin control plane.
  app.use('/api/abdm/master', require('./routes/abdmMasterAdmin.routes'));

  if (abdmConfig.featureM2) {
    const callbackLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: Number(process.env.ABDM_CALLBACK_RATE_LIMIT_PER_MINUTE || 3000),
      standardHeaders: true,
      legacyHeaders: false
    });
    app.use('/api/v3', callbackLimiter, require('./routes/abdmPublic.routes'));
  }
}

// For local sandbox testing, we mount both routes so you don't need to run two backend instances
mountHospitalRoutes();
mountMasterRoutes();

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  if (req) {
    req.auditError = {
      message: err.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
    };
  }
  console.error(err.stack || err);
  const status = Number(err.statusCode || err.status || 500);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong!' : err.message,
    ...(process.env.NODE_ENV !== 'production' && status >= 500 ? { details: err.message } : {})
  });
});

module.exports = app;
