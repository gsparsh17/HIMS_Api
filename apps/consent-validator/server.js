require('dotenv').config();
const mongoose = require('mongoose');
const { config, assertStartupConfig } = require('./src/config');
const { jwksStore } = require('./src/trust');
const app = require('./src/app');

async function start() {
  assertStartupConfig();
  await mongoose.connect(config.mongoUri, {
    maxPoolSize: Number(process.env.CONSENT_VALIDATOR_MONGO_MAX_POOL_SIZE || 20),
    minPoolSize: Number(process.env.CONSENT_VALIDATOR_MONGO_MIN_POOL_SIZE || 2),
    serverSelectionTimeoutMS: Number(
      process.env.CONSENT_VALIDATOR_MONGO_SERVER_SELECTION_TIMEOUT_MS || 10000
    ),
    autoIndex: true
  });
  await jwksStore.refresh();
  if (config.requireMongoTransactions) {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && !hello.msg?.includes('isdbgrid')) {
      throw new Error(
        'Production consent frequency enforcement requires a MongoDB replica set or mongos'
      );
    }
  }
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `${config.serviceName} ${config.version} listening on ${config.host}:${config.port}`
    );
  });
  server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 15000);
  server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 5000);

  const shutdown = async (signal) => {
    console.log(`${signal} received; stopping consent validator`);
    server.close(async () => {
      await mongoose.disconnect().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Consent validator failed to start:', error.message);
  process.exit(1);
});
