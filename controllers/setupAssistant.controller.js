const SetupAssistantUsage = require('../models/SetupAssistantUsage');
const setupAssistant = require('../services/setupAssistant.service');
const geminiClinical = require('../services/geminiClinical.service');
const { requireHospitalId } = require('../services/tenantScope.service');
const { effectiveMainFeaturePermissions } = require('../utils/mainFeatureAccess');

const DAILY_LIMIT = 2;

function localDateKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.HOSPITAL_TIMEZONE || process.env.HOSPITAL_TIME_ZONE || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => ['year', 'month', 'day'].includes(part.type))
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function usageFor(userId, hospitalId) {
  const dateKey = localDateKey();
  const usage = await SetupAssistantUsage.findOne({ userId, hospitalId, dateKey }).lean();
  const used = Math.max(0, Number(usage?.count || 0));
  return { dateKey, used, remaining: Math.max(0, DAILY_LIMIT - used), limit: DAILY_LIMIT };
}

async function consumeUsage(userId, hospitalId) {
  const dateKey = localDateKey();
  let row = await SetupAssistantUsage.findOneAndUpdate(
    { userId, hospitalId, dateKey, count: { $lt: DAILY_LIMIT } },
    { $inc: { count: 1 }, $set: { lastUsedAt: new Date() } },
    { new: true }
  );

  if (!row) {
    try {
      row = await SetupAssistantUsage.create({ userId, hospitalId, dateKey, count: 1, lastUsedAt: new Date() });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      row = await SetupAssistantUsage.findOneAndUpdate(
        { userId, hospitalId, dateKey, count: { $lt: DAILY_LIMIT } },
        { $inc: { count: 1 }, $set: { lastUsedAt: new Date() } },
        { new: true }
      );
    }
  }

  if (!row || row.count > DAILY_LIMIT) {
    const error = new Error('Daily MediQliq Assistant limit reached. You can ask 2 questions per day.');
    error.statusCode = 429;
    throw error;
  }

  return { dateKey, used: row.count, remaining: Math.max(0, DAILY_LIMIT - row.count), limit: DAILY_LIMIT };
}

exports.status = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const [setup, usage] = await Promise.all([
      setupAssistant.getStatus({ user: req.user, hospitalId }),
      usageFor(req.user._id, hospitalId),
    ]);
    res.json({ success: true, data: { ...setup, gemini: usage }, cacheTtlSeconds: 1800 });
  } catch (error) {
    next(error);
  }
};

exports.skip = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const stepKey = String(req.params.stepKey || '').trim();
    const skipped = req.body?.skipped !== false;
    const setup = await setupAssistant.setSkipped({ user: req.user, hospitalId, stepKey, skipped });
    const usage = await usageFor(req.user._id, hospitalId);
    res.json({ success: true, data: { ...setup, gemini: usage }, cacheTtlSeconds: 1800 });
  } catch (error) {
    next(error);
  }
};

exports.clearSkips = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const setup = await setupAssistant.clearSkipped({ user: req.user, hospitalId });
    const usage = await usageFor(req.user._id, hospitalId);
    res.json({ success: true, data: { ...setup, gemini: usage }, cacheTtlSeconds: 1800 });
  } catch (error) {
    next(error);
  }
};

exports.ask = async (req, res, next) => {
  try {
    const hospitalId = requireHospitalId(req);
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ success: false, error: 'question is required' });
    if (question.length > 1500) return res.status(400).json({ success: false, error: 'question must be 1500 characters or fewer' });

    const setup = await setupAssistant.getStatus({ user: req.user, hospitalId });
    if (!setup.setupComplete) {
      return res.status(409).json({
        success: false,
        error: 'Complete or intentionally skip all setup steps available to your permissions before using MediQliq Assistant.',
        data: setup,
      });
    }

    const usage = await consumeUsage(req.user._id, hospitalId);
    try {
      const answer = await geminiClinical.askMediqliq({
        question,
        role: setup.role,
        allowedFeatures: effectiveMainFeaturePermissions(req.user)
          .filter((permission) => permission.access !== 'none')
          .map((permission) => permission.moduleKey),
      });
      return res.json({ success: true, data: { answer, gemini: usage } });
    } catch (error) {
      // A Gemini/network failure does not consume one of the user's two uses.
      await SetupAssistantUsage.updateOne(
        { userId: req.user._id, hospitalId, dateKey: usage.dateKey, count: { $gt: 0 } },
        { $inc: { count: -1 } }
      ).catch(() => {});
      throw error;
    }
  } catch (error) {
    next(error);
  }
};
