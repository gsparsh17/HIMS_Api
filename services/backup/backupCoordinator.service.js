const os = require('os');
const BackupState = require('../../models/BackupState');
const BackupRun = require('../../models/BackupRun');
const {
  coordinatorLockEnabled,
  instanceId,
  lockLeaseMs,
  lockHeartbeatMs,
  timezone
} = require('./config');

const LOCK_KEY = 'backup_execution_lock';

function ownerIdentity() {
  return {
    instanceId: instanceId(),
    hostname: os.hostname(),
    pid: process.pid
  };
}

function ownerToken() {
  const owner = ownerIdentity();
  return `${owner.instanceId}:${owner.hostname}:${owner.pid}`;
}

function timeZoneParts(date = new Date(), tz = timezone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
    second: Number(map.second || 0)
  };
}

function localDateKey(date = new Date(), tz = timezone()) {
  const parts = timeZoneParts(date, tz);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function scheduledRunKey(type, date = new Date(), tz = timezone()) {
  return `scheduled:${String(type).toLowerCase()}:${localDateKey(date, tz)}`;
}

async function successfulScheduleExists(scheduleKey) {
  if (!scheduleKey) return false;
  return Boolean(await BackupRun.exists({
    scheduleKey,
    status: { $in: ['success', 'partial', 'skipped'] }
  }));
}

async function acquireLease({ reason = 'backup' } = {}) {
  if (!coordinatorLockEnabled()) {
    return { acquired: true, disabled: true, ownerToken: ownerToken() };
  }

  const now = new Date();
  const leaseUntil = new Date(now.getTime() + lockLeaseMs());
  const identity = ownerIdentity();
  const token = ownerToken();

  const value = {
    ownerToken: token,
    instanceId: identity.instanceId,
    hostname: identity.hostname,
    pid: identity.pid,
    reason,
    acquiredAt: now,
    heartbeatAt: now,
    lockedUntil: leaseUntil
  };

  let doc = await BackupState.findOneAndUpdate(
    {
      key: LOCK_KEY,
      $or: [
        { 'value.lockedUntil': { $lte: now } },
        { 'value.lockedUntil': { $exists: false } },
        { 'value.ownerToken': token }
      ]
    },
    { $set: { value } },
    { new: true }
  ).lean();

  if (!doc) {
    try {
      doc = await BackupState.create({ key: LOCK_KEY, value });
      doc = doc.toObject();
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  if (doc?.value?.ownerToken === token) {
    return {
      acquired: true,
      ownerToken: token,
      lockedUntil: doc.value.lockedUntil,
      instanceId: identity.instanceId,
      hostname: identity.hostname,
      pid: identity.pid
    };
  }

  const current = await BackupState.findOne({ key: LOCK_KEY }).lean();
  return {
    acquired: false,
    ownerToken: token,
    current: current?.value || null
  };
}

async function renewLease(token) {
  if (!coordinatorLockEnabled()) return true;
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + lockLeaseMs());
  const result = await BackupState.updateOne(
    { key: LOCK_KEY, 'value.ownerToken': token },
    {
      $set: {
        'value.heartbeatAt': now,
        'value.lockedUntil': lockedUntil
      }
    }
  );
  return Number(result.modifiedCount || result.nModified || 0) > 0;
}

async function releaseLease(token, outcome = 'released') {
  if (!coordinatorLockEnabled()) return true;
  const now = new Date();
  const result = await BackupState.updateOne(
    { key: LOCK_KEY, 'value.ownerToken': token },
    {
      $set: {
        'value.lastOwnerToken': token,
        'value.lastReleasedAt': now,
        'value.lastOutcome': outcome,
        'value.ownerToken': null,
        'value.instanceId': null,
        'value.hostname': null,
        'value.pid': null,
        'value.reason': null,
        'value.lockedUntil': new Date(0),
        'value.heartbeatAt': now
      }
    }
  );
  return Number(result.modifiedCount || result.nModified || 0) > 0;
}

function startLeaseHeartbeat(token) {
  if (!coordinatorLockEnabled()) return () => {};
  const timer = setInterval(() => {
    renewLease(token).catch((error) => {
      console.error(`[BackupCoordinator] Failed to renew backup lease: ${error.message}`);
    });
  }, lockHeartbeatMs());
  timer.unref?.();
  return () => clearInterval(timer);
}

async function getCoordinatorStatus() {
  const lock = await BackupState.findOne({ key: LOCK_KEY }).lean().catch(() => null);
  const value = lock?.value || null;
  const active = Boolean(value?.ownerToken && value?.lockedUntil && new Date(value.lockedUntil).getTime() > Date.now());
  return {
    lockEnabled: coordinatorLockEnabled(),
    active,
    currentOwner: active ? {
      instanceId: value.instanceId || null,
      hostname: value.hostname || null,
      pid: value.pid || null,
      reason: value.reason || null,
      acquiredAt: value.acquiredAt || null,
      heartbeatAt: value.heartbeatAt || null,
      lockedUntil: value.lockedUntil || null
    } : null,
    lastReleasedAt: value?.lastReleasedAt || null,
    lastOutcome: value?.lastOutcome || null
  };
}

module.exports = {
  LOCK_KEY,
  ownerIdentity,
  ownerToken,
  timeZoneParts,
  localDateKey,
  scheduledRunKey,
  successfulScheduleExists,
  acquireLease,
  renewLease,
  releaseLease,
  startLeaseHeartbeat,
  getCoordinatorStatus
};
