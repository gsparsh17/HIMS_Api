const dotenv = require('dotenv');
dotenv.config();

const connectDB = require('./config/db');
const app = require('./app');
const { updateCalendar } = require('./jobs/calendarJob');

const startServer = async () => {
  try {

    await connectDB();
    console.log('✅ MongoDB Connected');

    const PORT = process.env.PORT || 5000;

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

    // START CRON JOB AFTER DB CONNECTS
    updateCalendar();

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();