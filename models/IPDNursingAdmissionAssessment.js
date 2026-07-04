const mongoose = require('mongoose');

const yesNoDetailsSchema = new mongoose.Schema({
  value: { type: Boolean, default: false },
  description: { type: String, trim: true },
  action: { type: String, trim: true }
}, { _id: false });

const checklistSchema = new mongoose.Schema({
  room: Boolean,
  bathroom: Boolean,
  emergencyLight: Boolean,
  lightControls: Boolean,
  sideRails: Boolean,
  bedControls: Boolean,
  nurseCall: Boolean,
  telephone: Boolean,
  toiletRail: Boolean,
  footstool: Boolean,
  television: Boolean,
  smokingPolicy: Boolean,
  visitingPolicy: Boolean,
  patientInformationChannel: Boolean,
  handbookGiven: Boolean
}, { _id: false });

const nursingAdmissionAssessmentSchema = new mongoose.Schema({
  admissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDAdmission', required: true, index: true, unique: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true },

  arrivalTime: { type: Date },
  admissionMode: {
    type: String,
    enum: ['Walking', 'Wheelchair', 'Stretcher', 'Other', ''],
    default: ''
  },
  accompaniedOnAdmission: { type: Boolean, default: false },
  companionName: { type: String, trim: true },
  relation: { type: String, trim: true },
  contactNumber: { type: String, trim: true },
  primaryLanguage: { type: String, trim: true },
  interpreterNeeded: { type: Boolean, default: false },
  culturalReligiousBarrier: yesNoDetailsSchema,
  consultantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
  unit: { type: String, trim: true },
  wardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ward' },
  bedId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bed' },

  initialVitals: {
    temperature: Number,
    temperatureUnit: { type: String, enum: ['Celsius', 'Fahrenheit'], default: 'Celsius' },
    pulse: Number,
    spo2: Number,
    bloodPressure: { systolic: Number, diastolic: Number },
    respiratoryRate: Number,
    height: Number,
    weight: Number,
    recordedAt: Date,
    vitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'IPDVitals' }
  },

  valuablesHandedOverToAttendant: { type: Boolean, default: false },
  attendantName: { type: String, trim: true },
  attendantRelation: { type: String, trim: true },
  attendantAcknowledgement: { type: String, trim: true },
  valuables: [{ item: String, quantity: Number, remarks: String }],

  patientOrientationStatus: {
    type: String,
    enum: ['Conscious', 'Unconscious', 'Disoriented', 'Drowsy', 'Other', ''],
    default: ''
  },
  orientationChecklist: checklistSchema,

  allergyKnown: {
    type: String,
    enum: ['Known', 'Unknown', 'None', ''],
    default: ''
  },
  allergyDetails: { type: String, trim: true },
  transfusionReaction: { type: String, trim: true },
  foodAllergy: { type: String, trim: true },
  diet: { type: String, trim: true },
  currentMedications: [{
    drug: String,
    dose: String,
    frequency: String,
    lastDoseAt: Date,
    remarks: String
  }],
  medicinesDisposition: {
    type: String,
    enum: ['Sent Home', 'Kept With Patient', 'Kept With Nurse', 'Other', ''],
    default: ''
  },
  medicinesBroughtToHospital: { type: Boolean, default: false },

  functionalAssessment: [{
    activity: String,
    status: { type: String, enum: ['Independent', 'Assist', 'Dependent', ''] },
    remarks: String
  }],
  painScore: { type: Number, min: 0, max: 10 },
  painNote: { type: String, trim: true },

  fallRisk: {
    items: [{ key: String, label: String, value: String, score: Number }],
    total: { type: Number, default: 0 },
    riskBand: { type: String, trim: true },
    configVersion: { type: String, default: 'pending-clinical-approval' }
  },
  pressureUlcerRisk: {
    bedsorePresent: { type: Boolean, default: false },
    location: String,
    size: String,
    witnessedBy: String,
    attendantName: String,
    attendantAcknowledgement: String,
    items: [{ key: String, label: String, value: String, score: Number }],
    total: { type: Number, default: 0 },
    riskBand: { type: String, trim: true },
    configVersion: { type: String, default: 'pending-clinical-approval' }
  },

  specialNeeds: {
    hearingImpairment: yesNoDetailsSchema,
    visualImpairment: yesNoDetailsSchema,
    speechImpairment: yesNoDetailsSchema,
    incontinence: yesNoDetailsSchema,
    prosthesis: yesNoDetailsSchema,
    oxygenTherapy: yesNoDetailsSchema,
    other: yesNoDetailsSchema
  },
  nursingCarePlan: [{
    diagnosis: String,
    selected: Boolean,
    interventionPlan: String,
    remarks: String
  }],

  assessmentAt: { type: Date, default: Date.now },
  assessedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assessedByName: { type: String, trim: true },
  areaInChargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  areaInChargeName: { type: String, trim: true },
  status: {
    type: String,
    enum: ['Draft', 'Completed', 'Signed', 'Amended'],
    default: 'Draft',
    index: true
  },
  signedAt: { type: Date },
  signedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amendedAt: Date,
  amendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amendmentReason: { type: String, trim: true },
  notes: { type: String, trim: true }
}, { timestamps: true });

nursingAdmissionAssessmentSchema.index({ hospitalId: 1, admissionId: 1 });

module.exports = mongoose.model('IPDNursingAdmissionAssessment', nursingAdmissionAssessmentSchema);