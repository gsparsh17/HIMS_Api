const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const abdmConfig = require('./config/abdm.config');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

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
      // Server-to-server and same-origin requests may not include Origin.
      if (!origin) return callback(null, true);
      if (origins.includes(origin)) return callback(null, true);

      // Local development may run without an explicit allow-list.
      if (!isProduction && origins.length === 0) return callback(null, true);

      const error = new Error('Origin is not allowed by CORS');
      error.statusCode = 403;
      return callback(error);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-Master-Admin-Key'],
    maxAge: 86400
  })
);
app.use(
  helmet({
    // This service returns JSON APIs, not HTML pages.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: isProduction
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: 'no-referrer' }
  })
);

// Never expose development artifacts if an upstream proxy accidentally forwards them.
const blockedSourcePath = /(?:\.map$)|^\/(?:\.git(?:\/|$)|\.env(?:\.[^/]*)?$|src(?:\/|$)|node_modules(?:\/|$)|package(?:-lock)?\.json$|vite\.config\.[^/]+$|server\d*\.js$|app\.js$)/i;
app.use((req, res, next) => {
  if (blockedSourcePath.test(req.path)) return res.status(404).end();
  return next();
});
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
app.use('/api', (req, res, next) => {
  // Patient and financial responses must not be stored by browsers or shared proxies.
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, status: 'ok' });
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
    './models/AbdmIdentityTransaction',
    './models/AbdmCredential',
    './models/AbdmHospitalConsent',
    './models/AbdmHiuRequest',
    './models/AbdmImportedRecord',
    './models/AbdmDataTransfer',
    './models/AbdmAccessAudit',
    './models/AbdmSubscription',
    './models/AbdmHospitalJob',
    './models/AbdmPacket',
    './models/AbdmPacketVersion',
    './models/AbdmDisclosureLedger',
    './models/Immunization',
    './models/ClinicalDocument',
    './models/IPDConsent',
    './models/DomainEvent',
    './models/UserPrintIdentity',
    './models/PrintIdentityAsset',
    './models/DocumentSignature',
    './models/EncounterDocument',
    './models/HospitalSequence',
    './models/StoreLocation',
    './models/InventoryLot',
    './models/StockReservation',
    './models/GoodsReceiptNote',
    './models/StoreIssueReturn',
    './models/StockTransfer',
    './models/StockCount',
    './models/PurchaseReturn',
    './models/OTReadinessChecklist',
    './models/OTSurgicalSafetyChecklist',
    './models/OTPreAnaesthesiaAssessment',
    './models/OTAnesthesiaRecord',
    './models/OTOperativeNote',
    './models/OTRecoveryRecord',
    './models/OTCaseInventoryUsage',
    './models/OTSpecimen',
    './models/Payer',
    './models/RateCard',
    './models/RateCardItem',
    './models/AdmissionCoverage',
    './models/ClaimCase',
    './models/SponsorLedgerEntry',
    './models/PackageEpisode',
    './models/RepricingBatch',
    './models/CoverageUtilization',
    './models/IPDBedTransfer',
    './models/IPDAccommodationSegment',
    './models/BiometricDevice',
    './models/BiometricEmployeeMap',
    './models/AttendancePunch',
    './models/StoredFile',
    './models/NabhSetting',
    './models/NabhRecord',
    './models/NotificationDelivery',
    './models/TerminologyCode',
    './models/PatientVerification'
  ].forEach((modelPath) => require(modelPath));
}

function mountHospitalRoutes() {
  preloadHospitalModels();
  const auditLogger = require('./middlewares/auditLogger');
  app.use(auditLogger({ apiPrefix: '/api' }));
  
  // Stored files are tenant-protected by file.routes/file.controller. Mount
  // this before the global /api authentication middleware so public files can
  // remain public and private files can use optional bearer/cookie auth.
  app.use('/api/files', require('./routes/file.routes'));
  app.use('/api/auth', require('./routes/auth.routes'));
  // Public contact endpoint used by the marketing/demo-request form. It has its
  // own validation and rate limiting; all remaining hospital APIs require login.
  app.use('/api/email', require('./routes/emailRoutes.js'));
  app.use('/api/public/hospital-profile', require('./routes/publicHospitalProfile.routes.js'));
  // Patient portal has its own patient-scoped JWT boundary and must be mounted before staff auth.
  app.use('/api/patient-portal', require('./routes/patientPortal.routes.js'));
  const authMiddleware = require('./middlewares/auth');
  app.use('/api', authMiddleware.protect);
  app.use('/api', authMiddleware.requireCompletedMfaSetup);


  app.use('/api/payments', require('./routes/paymentRoutes'));
  app.use('/api/imports', require('./routes/bulkImport.routes.js'));
  app.use('/api/admin/config/imports', require('./routes/configurationImport.routes.js'));
  app.use('/api/admin/config/service-masters', require('./routes/serviceMaster.routes.js'));
  app.use('/api/clinical-ai', require('./routes/clinicalAi.routes.js'));
  app.use('/api/audit-logs', require('./routes/auditLog.routes'));
  app.use('/api/nabh', require('./routes/nabh.routes'));
  app.use('/api/patients', require('./routes/patient.routes'));
  if (abdmConfig.featureM1) app.use('/api/abha', require('./routes/abha.routes'));
  app.use('/api/doctors', require('./routes/doctor.routes'));
  app.use('/api/nurses', require('./routes/nurse.routes'));
  app.use('/api/staff', require('./routes/staff.routes'));
  app.use('/api/insurance-providers', require('./routes/insuranceProvider.routes'));
  app.use('/api/appointments', require('./routes/appointment.routes'));
  app.use('/api/store', require('./routes/store.routes'));
  app.use('/api/hr', require('./routes/hr.routes'));
  app.use('/api/biometric', require('./routes/biometric.routes'));
  app.use('/api/prescriptions', require('./routes/prescription.routes'));
  app.use('/api/procedurerequests', require('./routes/procedureRequest.routes'));
  app.use('/api/procedures', require('./routes/procedureRoutes'));
  app.use('/api/NLEMmedicines', require('./routes/NLEMmedicineRoutes'));
  app.use('/api/billing', require('./routes/billing.routes'));
  app.use('/api', require('./routes/tariff.routes'));
  app.use('/api', require('./routes/coverage.routes'));
  app.use('/api', require('./routes/repricing.routes'));
  app.use('/api', require('./routes/claims.routes'));
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
  app.use('/api/ipd/consents', require('./routes/ipdConsent.routes'));
  app.use('/api/ipd', require('./routes/ipd.routes'));
  app.use('/api/ipd', require('./routes/ipdTransfer.routes'));
  app.use('/api/wards', require('./routes/ward.routes'));
  app.use('/api/admin/backups', require('./routes/backup.routes'));
  app.use('/api/salaries', require('./routes/salary.routes'));
  app.use('/api/revenue', require('./routes/revenue.routes'));
  app.use('/api/finance', require('./routes/finance.routes.js'));
  app.use('/api/desk', require('./routes/desk.routes.js'));
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
  app.use('/api/support-tickets', require('./routes/supportTicket.routes.js'));
  app.use('/api/external-lab', require('./routes/externalLab.routes'));
  app.use('/api/license', require('./routes/license.routes.js'));
  app.use('/api/icd11', require('./routes/icd11.routes.js'));
  app.use('/api/ot', require('./routes/ot.routes.js'));
  app.use('/api/print-identities', require('./routes/printIdentity.routes.js'));
  app.use('/api/patient-identities', require('./routes/patientIdentity.routes.js'));

  app.use('/api/admission-workflows', require('./routes/admissionWorkflow.routes.js'));
  app.use('/api/clinical-assessments', require('./routes/clinicalAssessment.routes.js'));
  app.use('/api/clinical-order-sets', require('./routes/clinicalOrderSet.routes.js'));
  app.use('/api/blood-bank', require('./routes/bloodBank.routes.js'));
  app.use('/api/safety', require('./routes/safety.routes.js'));
  app.use('/api/emergency-care', require('./routes/emergencyCare.routes.js'));
  app.use('/api/patient-experience', require('./routes/patientExperience.routes.js'));
  app.use('/api/operational-settings', require('./routes/operationalSettings.routes.js'));
  app.use('/api/help', require('./routes/help.routes.js'));
  app.use('/api/releases', require('./routes/release.routes.js'));
  app.use('/api/portability', require('./routes/portability.routes.js'));
  app.use('/api/billing-documents', require('./routes/billingDocument.routes.js'));
  app.use('/api/financial-communications', require('./routes/financialCommunication.routes.js'));

  app.use('/api/documents', require('./routes/document.routes.js'));
  app.use('/api/mis', require('./routes/mis.routes.js'));
  app.use('/api/approvals', require('./routes/approval.routes.js'));
  app.use('/api', require('./routes/userAccess.routes'));

  if (abdmConfig.featureM2 || abdmConfig.featureM3) {
    // Master -> hospital callbacks. Every request is authenticated with the
    // hospital's HMAC connector key and protected against replay.
    app.use('/internal/abdm', require('./routes/abdmConnector.routes'));
  }
  if (abdmConfig.featureM2) {
    app.use('/api/abdm', require('./routes/abdmHospital.routes'));
  }
  if (abdmConfig.featureM3) {
    app.use('/api/abdm/hiu', require('./routes/abdmHiu.routes'));
  }
}

// This repository is hospital-only. Master and public ABDM callback routes are not mounted.
mountHospitalRoutes();


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
