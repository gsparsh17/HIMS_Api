const mongoose = require("mongoose");

function redactMongoUri(uri) {
  if (!uri) return '<missing MONGO_URI>';
  try {
    const parsed = new URL(uri);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return String(uri).replace(/(mongodb(?:\+srv)?:\/\/)([^@/]+)@/i, '$1***:***@');
  }
}

const connectDB = async () => {
  try {
    console.log("Connecting to:", redactMongoUri(process.env.MONGO_URI));

    await mongoose.connect(process.env.MONGO_URI);

    console.log("MongoDB connected");
  } catch (error) {
    console.error(error);

    if (error.reason?.servers) {
      for (const [host, server] of error.reason.servers) {
        console.log("\nHost:", host);
        console.log(server.error);
      }
    }

    process.exit(1);
  }
};

module.exports = connectDB;
module.exports.redactMongoUri = redactMongoUri;
