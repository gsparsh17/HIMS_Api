function generateHourlySlots(start, end) {
  const slots = [];
  let current = new Date(`1970-01-01T${start}:00`);
  const endTime = new Date(`1970-01-01T${end}:00`);

  while (current < endTime) {
    slots.push(current.toTimeString().slice(0, 5));
    current.setHours(current.getHours() + 1);
  }
  return slots;
}

function getShiftSlots(shift, dayIndex) {
  // Handle rotating shift (dayIndex will help rotate shifts)
  switch (shift) {
    case 'Morning': return generateHourlySlots('07:00', '15:00');
    case 'Evening': return generateHourlySlots('15:00', '23:00');
    case 'Night': return generateHourlySlots('23:00', '07:00');
    case 'Rotating': {
      const shifts = [
        generateHourlySlots('07:00', '15:00'),
        generateHourlySlots('15:00', '23:00'),
        generateHourlySlots('23:00', '07:00')
      ];
      return shifts[dayIndex % 3]; // rotate daily
    }
    default: return [];
  }
}

function getPartTimeSlots(timeSlots) {
  let slots = [];
  timeSlots.forEach(slot => {
    slots = [...slots, ...generateHourlySlots(slot.start, slot.end)];
  });
  return slots;
}

module.exports = { generateHourlySlots, getShiftSlots, getPartTimeSlots };
