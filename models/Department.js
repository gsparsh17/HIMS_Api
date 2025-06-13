const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  head_doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor' }
});

module.exports = mongoose.model('Department', departmentSchema);
