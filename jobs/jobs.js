const cron = require('node-cron');
const { calculateFullTimeSalaries } = require('../controllers/salary.controller');

// Run at 11:59 PM every day to calculate part-time doctors' daily salaries
// (This would be triggered by appointment completion events instead)

// Run on the last day of every month at 11:59 PM for full-time doctors
cron.schedule('59 23 28-31 * *', async () => {
  const today = new Date();
  const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  
  if (today.getDate() === lastDayOfMonth.getDate()) {
    console.log('Running monthly salary calculation for full-time doctors...');
    try {
      const results = await calculateFullTimeSalaries();
      console.log('Monthly salary calculation completed:', results);
    } catch (error) {
      console.error('Error in monthly salary calculation:', error);
    }
  }
});

// Run at the beginning of each month to process pending salaries
cron.schedule('0 0 1 * *', async () => {
  console.log('Starting new month - processing pending salaries...');
  // You can add logic here to process pending salaries
});

module.exports = cron;