const mongoose = require('mongoose');

const calendarSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  days: [
    {
      date: { type: Date, required: true },
      dayName: String,
      doctors: [
        {
          doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' },
          availableSlots: [String], // ["09:00", "10:00"]
          bookedSlots: [String]
        }
      ]
    }
  ]
});

module.exports = mongoose.model('Calendar', calendarSchema);
