'use strict';

const { hospitalDayBounds, isDateKey } = require('./hospitalDateTime');
const { currentContext } = require('./operationTimeContext');

function semanticDateRange(startDate, endDate, timeZone = currentContext()?.timeZone) {
  const range = {};
  if (startDate) {
    range.$gte = isDateKey(startDate) ? hospitalDayBounds(startDate, timeZone).start : new Date(startDate);
  }
  if (endDate) {
    range.$lt = isDateKey(endDate) ? hospitalDayBounds(endDate, timeZone).end : new Date(endDate);
  }
  return range;
}

module.exports = { semanticDateRange };
