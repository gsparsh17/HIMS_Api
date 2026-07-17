const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    console.log("Connecting to:", process.env.MONGO_URI);

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