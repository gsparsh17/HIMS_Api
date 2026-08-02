const AppointmentSequence = require('../models/AppointmentSequence');

async function nextAppointmentToken({ hospitalId, patientType, appointmentDate, session }) {
  const prefix = patientType === 'ipd' ? 'IPD' : 'OPD';
  const date = new Date(appointmentDate || Date.now());
  const dateKey = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const sequence = await AppointmentSequence.findOneAndUpdate(
    { hospitalId, prefix, dateKey },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return `${prefix}-${dateKey}-${String(sequence.value).padStart(3, '0')}`;
}

module.exports = { nextAppointmentToken };
