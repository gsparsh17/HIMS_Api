// function generateHourlySlots(start, end) {
//   const slots = [];
//   let current = new Date(`1970-01-01T${start}:00`);
//   const endTime = new Date(`1970-01-01T${end}:00`);

//   while (current < endTime) {
//     slots.push(current.toTimeString().slice(0, 5));
//     current.setHours(current.getHours() + 1);
//   }
//   return slots;
// }

// function getShiftSlots(shift, dayIndex) {
//   // Handle rotating shift (dayIndex will help rotate shifts)
//   switch (shift) {
//     case 'Morning': return generateHourlySlots('07:00', '15:00');
//     case 'Evening': return generateHourlySlots('15:00', '23:00');
//     case 'Night': return generateHourlySlots('23:00', '07:00');
//     case 'Rotating': {
//       const shifts = [
//         generateHourlySlots('07:00', '15:00'),
//         generateHourlySlots('15:00', '23:00'),
//         generateHourlySlots('23:00', '07:00')
//       ];
//       return shifts[dayIndex % 3]; // rotate daily
//     }
//     default: return [];
//   }
// }

// function getPartTimeSlots(timeSlots) {
//   let slots = [];
//   timeSlots.forEach(slot => {
//     slots = [...slots, ...generateHourlySlots(slot.start, slot.end)];
//   });
//   return slots;
// }

// module.exports = { generateHourlySlots, getShiftSlots, getPartTimeSlots };

function getShiftTimeRange(shift, dayIndex, baseDate = new Date()) {
  // Normalize baseDate to midnight
  const date = new Date(baseDate);
  date.setHours(0, 0, 0, 0);

  let start, end;

  switch (shift) {
    case 'Morning':
      start = new Date(date.setHours(7, 0, 0, 0));
      end = new Date(date.setHours(15, 0, 0, 0));
      break;
    case 'Evening':
      start = new Date(date.setHours(15, 0, 0, 0));
      end = new Date(date.setHours(23, 0, 0, 0));
      break;
    case 'Night':
      start = new Date(date.setHours(23, 0, 0, 0));
      end = new Date(date.getTime() + 8 * 60 * 60 * 1000); // next day 07:00
      break;
    case 'Rotating': {
      const shifts = [
        { startHour: 7, endHour: 15 },
        { startHour: 15, endHour: 23 },
        { startHour: 23, endHour: 7 }
      ];
      const { startHour, endHour } = shifts[dayIndex % 3];
      start = new Date(date.setHours(startHour, 0, 0, 0));
      if (endHour < startHour) {
        // overnight (23 → 07 next day)
        end = new Date(date.getTime() + (24 - startHour + endHour) * 60 * 60 * 1000);
      } else {
        end = new Date(date.setHours(endHour, 0, 0, 0));
      }
      break;
    }
    default:
      return null;
  }

  const duration = Math.round((end - start) / (1000 * 60)); // minutes
  return { startTime: start, endTime: end, duration };
}

function getPartTimeRanges(timeSlots, baseDate = new Date()) {
  const date = new Date(baseDate);
  date.setHours(0, 0, 0, 0);

  return timeSlots.map(slot => {
    const [startHour, startMinute] = slot.start.split(':').map(Number);
    const [endHour, endMinute] = slot.end.split(':').map(Number);

    const start = new Date(date.setHours(startHour, startMinute, 0, 0));
    let end = new Date(date.setHours(endHour, endMinute, 0, 0));
    if (end <= start) {
      // overnight slot
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }

    const duration = Math.round((end - start) / (1000 * 60));
    return { startTime: start, endTime: end, duration };
  });
}

module.exports = { getShiftTimeRange, getPartTimeRanges };
