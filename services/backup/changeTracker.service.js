const mongoose = require('mongoose');
const BackupChange = require('../../models/BackupChange');
const BackupState = require('../../models/BackupState');
const { incrementalEnabled } = require('./config');

const INTERNAL_COLLECTIONS = new Set(['backupchanges', 'backupstates', 'backupruns']);

let changeStream = null;
let status = {
  enabled: false,
  running: false,
  supported: null,
  startedAt: null,
  lastEventAt: null,
  lastError: null
};

async function getResumeToken() {
  const state = await BackupState.findOne({ key: 'change_stream_resume' }).lean();
  return state?.value?.resumeToken || null;
}

async function saveResumeToken(resumeToken) {
  if (!resumeToken) return;
  await BackupState.updateOne(
    { key: 'change_stream_resume' },
    { $set: { value: { resumeToken, savedAt: new Date() } } },
    { upsert: true }
  );
}

async function persistChange(change) {
  const collectionName = change?.ns?.coll;
  if (!collectionName || INTERNAL_COLLECTIONS.has(collectionName) || collectionName.startsWith('system.')) return;
  if (!['insert', 'update', 'replace', 'delete'].includes(change.operationType)) return;
  if (!change.documentKey || change.documentKey._id === undefined) return;

  await BackupChange.create({
    collectionName,
    operationType: change.operationType,
    documentKey: change.documentKey,
    clusterTime: change.clusterTime,
    resumeToken: change._id,
    capturedAt: new Date()
  });
  await saveResumeToken(change._id);
  status.lastEventAt = new Date();
}

async function startChangeTracker() {
  status.enabled = incrementalEnabled();
  if (!status.enabled) return { ...status };
  if (changeStream) return { ...status };
  if (mongoose.connection.readyState !== 1) {
    status.lastError = 'MongoDB is not connected';
    return { ...status };
  }

  try {
    const resumeToken = await getResumeToken();
    const pipeline = [{
      $match: {
        operationType: { $in: ['insert', 'update', 'replace', 'delete'] },
        'ns.db': mongoose.connection.name,
        'ns.coll': { $nin: [...INTERNAL_COLLECTIONS] }
      }
    }];
    const options = { fullDocument: 'updateLookup' };
    if (resumeToken) options.resumeAfter = resumeToken;

    changeStream = mongoose.connection.watch(pipeline, options);
    status = {
      ...status,
      enabled: true,
      running: true,
      supported: true,
      startedAt: new Date(),
      lastError: null
    };

    changeStream.on('change', (change) => {
      persistChange(change).catch((error) => {
        status.lastError = `Backup change journal write failed: ${error.message}`;
        console.error(status.lastError);
      });
    });

    changeStream.on('error', (error) => {
      status.running = false;
      status.supported = /replica set|mongos|change stream/i.test(String(error.message || '')) ? false : null;
      status.lastError = error.message;
      console.error(`Backup change tracker stopped: ${error.message}`);
      changeStream = null;
    });

    changeStream.on('close', () => {
      status.running = false;
      changeStream = null;
    });

    console.log('✅ Backup change tracker started (MongoDB Change Streams)');
    return { ...status };
  } catch (error) {
    status.running = false;
    status.supported = /replica set|mongos|change stream/i.test(String(error.message || '')) ? false : null;
    status.lastError = error.message;
    console.error(`Backup change tracker unavailable: ${error.message}`);
    return { ...status };
  }
}

async function stopChangeTracker() {
  if (changeStream) {
    const stream = changeStream;
    changeStream = null;
    await stream.close().catch(() => {});
  }
  status.running = false;
}

async function recoverChangeTrackerAfterFull() {
  if (!incrementalEnabled() || status.running) return { ...status };
  // A successful full backup is a safe new baseline. If a previous resume token
  // became invalid because the oplog window was lost, start a fresh stream from now.
  await BackupState.deleteOne({ key: 'change_stream_resume' }).catch(() => {});
  status.lastError = null;
  status.supported = null;
  return startChangeTracker();
}

function getChangeTrackerStatus() {
  return { ...status };
}

module.exports = {
  startChangeTracker,
  stopChangeTracker,
  getChangeTrackerStatus,
  recoverChangeTrackerAfterFull,
  INTERNAL_COLLECTIONS
};
