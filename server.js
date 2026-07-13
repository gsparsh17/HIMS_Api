const dotenv = require('dotenv');
dotenv.config();

const connectDB = require('./config/db');
const abdmConfig = require('./config/abdm.config');
const app = require('./app');

const startServer = async () => {
  try {
    await connectDB();
    console.log('✅ MongoDB Connected');

    const PORT = process.env.PORT || (abdmConfig.isMaster && !abdmConfig.isHospital ? 5004 : 5000);
    const server = app.listen(PORT, () => {
      console.log(`🚀 ${abdmConfig.appRole} server running on http://localhost:${PORT}`);
    });

    if (abdmConfig.isHospital) {
      const { startCalendarJob } = require('./jobs/calendarJob');
      startCalendarJob();
    }
    if (abdmConfig.isMaster) {
      const { startAbdmJobWorker } = require('./jobs/abdmJobWorker');
      startAbdmJobWorker();
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
