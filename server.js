const dotenv = require('dotenv');
dotenv.config();

const connectDB = require('./config/db');
const abdmConfig = require('./config/abdm.config');
const { assertRuntimeConfig } = require('./config/runtime.config');
assertRuntimeConfig();
const app = require('./app');

function validateProductionConfiguration() {
  // if (process.env.NODE_ENV !== 'production') return;
  const corsOrigins = String(process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '').trim();

  // if (jwtSecret.length < 32) {
  //   throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production');
  // }
  if (!corsOrigins) {
    throw new Error('CORS_ORIGINS or FRONTEND_URL must be configured in production');
  }
}

const startServer = async () => {
  try {
    validateProductionConfiguration();
    await connectDB();
    console.log('✅ MongoDB Connected');

    const PORT = process.env.PORT || (abdmConfig.isMaster && !abdmConfig.isHospital ? 5004 : 5000);
    const HOST = process.env.HOST || '127.0.0.1';
    const server = app.listen(PORT, HOST, () => {
      console.log(`🚀 ${abdmConfig.appRole} server listening on ${HOST}:${PORT}`);
    });

    // Conservative HTTP timeouts reduce exposure to slow-request attacks.
    server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
    server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 65000);
    server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 5000);

    if (abdmConfig.isHospital) {
      const { startCalendarJob } = require('./jobs/calendarJob');
      startCalendarJob();
    }
    if (abdmConfig.isMaster) {
      const { startAbdmJobWorker } = require('./jobs/abdmJobWorker');
      startAbdmJobWorker();
    }

    if (abdmConfig.isHospital) {
      const { startMISScheduleJob } = require('./jobs/misScheduleJob');
      startMISScheduleJob();
    }

    const shutdown = (signal) => {
      console.log(`\n${signal} received. Closing HTTP server...`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
