'use strict';

const cron = require('node-cron');
const { runDailyChargeCatchup } = require('../services/ipdRecurringCharge.service');

let task = null;

function lookbackStart(days) {
  const safeDays = Math.max(1, Math.min(31, Number(days || 1)));
  return new Date(Date.now() - (safeDays - 1) * 86400000);
}

async function execute({ startup = false } = {}) {
  try {
    // A server restart must not silently create months of historical nursing/RMO
    // charges. Scheduled runs operate on the current hospital day. Startup
    // catch-up looks back a small configurable window (default: today+yesterday).
    // Full historical catch-up remains available through the explicit API/script.
    const lookbackDays = startup
      ? Number(process.env.IPD_DAILY_CHARGE_STARTUP_LOOKBACK_DAYS || 2)
      : Number(process.env.IPD_DAILY_CHARGE_SCHEDULE_LOOKBACK_DAYS || 1);
    const fromDate = lookbackStart(lookbackDays);
    const summary = await runDailyChargeCatchup({
      throughDate: new Date(),
      fromDate,
      limit: Number(process.env.IPD_DAILY_CHARGE_BATCH_LIMIT || 1000)
    });
    console.log(`[IPD Daily Charges] ${startup ? 'startup ' : ''}catch-up complete`, {
      lookbackDays,
      ...summary
    });
  } catch (error) {
    console.error(`[IPD Daily Charges] ${startup ? 'startup ' : ''}catch-up failed`, error);
  }
}

function startIPDRecurringChargeJob() {
  if (process.env.IPD_DAILY_CHARGES_ENABLED === 'false') return null;
  if (task) return task;
  const expression = process.env.IPD_DAILY_CHARGE_CRON || '5 0 * * *';
  const timezone = process.env.HOSPITAL_TIME_ZONE || 'Asia/Kolkata';
  task = cron.schedule(expression, () => execute({ startup: false }), { timezone });

  setTimeout(
    () => execute({ startup: true }),
    Number(process.env.IPD_DAILY_CHARGE_STARTUP_DELAY_MS || 5000)
  ).unref();

  console.log(`[IPD Daily Charges] scheduled ${expression} (${timezone})`);
  return task;
}

module.exports = { startIPDRecurringChargeJob, execute, lookbackStart };
