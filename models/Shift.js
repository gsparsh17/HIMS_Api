const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema({
  name: { type: String, required: true }, // Morning, Evening, Night
  start_time: { type: String, required: true },
  end_time: { type: String, required: true }
});

module.exports = mongoose.model('Shift', shiftSchema);
