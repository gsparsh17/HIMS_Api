// const mongoose = require('mongoose');
const { DEFAULT_HOSPITAL_TIME_ZONE, calendarDayKey, dateKeyToStorageDate, dateKeyDayName } = require('../utils/hospitalDateTime');

// const calendarSchema = new mongoose.Schema({
//   hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
//   days: [
//     {
//       date: { type: Date, required: true },
//       dayName: String,
//       doctors: [
//         {
//           doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
//           availableSlots: [String], 
//           bookedSlots: [String]
//         }
//       ]
//     }
//   ]
// });

// module.exports = mongoose.model('Calendar', calendarSchema);


const mongoose = require('mongoose');

const bookedPatientSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  serialNumber: { type: Number, required: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' }
});

const doctorDaySchema = new mongoose.Schema({
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  bookedAppointments: [
    {
      startTime: { type: Date, required: true },
      endTime: { type: Date, required: true },
      duration: { type: Number, required: true }, // in minutes
      appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
      status: { 
        type: String, 
        enum: ['Available','Scheduled', 'InProgress', 'Completed', 'Cancelled'],
        default: 'Scheduled'
      }
    }
  ],
  bookedPatients: [bookedPatientSchema], // For number-based systems
  breaks: [
    {
      startTime: { type: Date, required: true },
      endTime: { type: Date, required: true },
      reason: String
    }
  ]
});

const calendarDaySchema = new mongoose.Schema({
  date: { type: Date, required: true },
  dateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
  dayName: String,
  doctors: [doctorDaySchema]
});

const calendarSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  timezone: { type: String, default: DEFAULT_HOSPITAL_TIME_ZONE },
  days: [calendarDaySchema]
});

calendarSchema.pre('validate', function normalizeCalendarDates(next) {
  try {
    const timeZone = this.timezone || DEFAULT_HOSPITAL_TIME_ZONE;
    for (const day of this.days || []) {
      const key = day.dateKey || calendarDayKey(day, timeZone);
      day.dateKey = key;
      day.date = dateKeyToStorageDate(key);
      day.dayName = dateKeyDayName(key);
    }
    this.timezone = timeZone;
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('Calendar', calendarSchema);