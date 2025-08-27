// const dotenv = require('dotenv');
// dotenv.config();

// const app = require('./app');
// const connectDB = require('./config/db');

// // Connect to MongoDB
// connectDB();

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on http://localhost:${PORT}`);
// });








// const dotenv = require('dotenv');
// dotenv.config();

// const connectDB = require('./config/db');
// const app = require('./app'); // We will start the app after the DB connection

// const startServer = async () => {
//   try {
//     // 1. Wait for the database to connect
//     await connectDB();
//     console.log('✅ MongoDB Connected');

//     // 2. Start the Express server
//     const PORT = process.env.PORT || 5000;
//     app.listen(PORT, () => {
//       console.log(`🚀 Server running on http://localhost:${PORT}`);
//     });
//   } catch (error) {
//     console.error('❌ Failed to start server:', error);
//     process.exit(1);
//   }
// };

// startServer();







const dotenv = require('dotenv');
dotenv.config();

const connectDB = require('./config/db');
const app = require('./app'); // We will start the app after the DB is connected

const startServer = async () => {
  try {
    // 1. Wait for the database to connect successfully
    await connectDB();
    console.log('✅ MongoDB Connected');

    // 2. Now that the DB is ready, start the Express server
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1); // Exit if the server can't start
  }
};

startServer();