const mongoose = require("mongoose");

const activationSchema = new mongoose.Schema({
  deviceId: String,
  hospitalName: String,
  activatedAt: { type: Date, default: Date.now },
  lastSeen: Date,
});

const licenseSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  plan: { type: String, default: "basic" },

  maxActivations: { type: Number, default: 2 },
  activations: [activationSchema],

  status: {
    type: String,
    enum: ["active", "blocked", "expired"],
    default: "active",
  },

  expiryDate: Date,

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("License", licenseSchema);