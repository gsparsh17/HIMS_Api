function stayDuration(start, end) {
  if (!start) return null;
  const ms = Math.max(0, new Date(end || Date.now()) - new Date(start));
  const hours = Math.round((ms / 3600000) * 10) / 10;
  return { hours, days: Math.round((hours / 24) * 10) / 10 };
}
module.exports = { stayDuration };
