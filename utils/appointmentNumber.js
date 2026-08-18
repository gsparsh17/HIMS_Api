const AppointmentSequence = require('../models/AppointmentSequence');
const {
  DEFAULT_HOSPITAL_TIME_ZONE,
  hospitalDateKey
} = require('./hospitalDateTime');

async function nextAppointmentToken({
  hospitalId,
  patientType,
  appointmentDate,
  appointmentDateKey,
  timeZone = DEFAULT_HOSPITAL_TIME_ZONE,
  session
}) {
  const prefix = patientType === 'ipd' ? 'IPD' : 'OPD';
  const key = appointmentDateKey || hospitalDateKey(appointmentDate || new Date(), timeZone);
  const sequenceDateKey = key.replaceAll('-', '');
  const sequence = await AppointmentSequence.findOneAndUpdate(
    { hospitalId, prefix, dateKey: sequenceDateKey },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return `${prefix}-${sequenceDateKey}-${String(sequence.value).padStart(3, '0')}`;
}

module.exports = { nextAppointmentToken };
