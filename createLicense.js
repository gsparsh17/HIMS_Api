// scripts/createLicense.js

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const License = require("./models/License");

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

// 🔑 simple key generator
const generateKey = () => {
  const part = () =>
    Math.random().toString(36).substring(2, 6).toUpperCase();
  return `HOSP-${part()}-${part()}-${part()}`;
};

const createLicense = async () => {
  try {
    await mongoose.connect(MONGO_URI);

    const key = generateKey();

    const license = new License({
      key,
      plan: "premium",
      maxActivations: 2,
      expiryDate: new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000 // 1 year
      ),
    });

    await license.save();

    console.log("✅ License Created:");
    console.log("KEY:", key);

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
};

createLicense();