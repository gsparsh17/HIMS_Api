const License = require("../models/License");
const jwt = require("jsonwebtoken");

const activateLicense = async (req, res) => {
  try {
    const { key, deviceId, hospitalName } = req.body;

    const license = await License.findOne({ key });

    if (!license) {
      return res.status(404).json({ message: "Invalid license key" });
    }

    if (license.status !== "active") {
      return res.status(403).json({ message: "License blocked or expired" });
    }

    const existing = license.activations.find(
      (a) => a.deviceId === deviceId
    );

    if (existing) {
      existing.lastSeen = new Date();
    } else {
      if (license.activations.length >= license.maxActivations) {
        return res.status(403).json({
          message: "Activation limit reached",
        });
      }

      license.activations.push({
        deviceId,
        hospitalName,
        lastSeen: new Date(),
      });
    }

    await license.save();

    const token = jwt.sign(
      {
        licenseId: license._id,
        deviceId,
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      success: true,
      token,
      license: {
        plan: license.plan,
        expiryDate: license.expiryDate,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const validateLicense = async (req, res) => {
  try {
    const { deviceId } = req.body;

    const license = await License.findById(req.user.licenseId);

    if (!license || license.status !== "active") {
      return res.status(403).json({ valid: false });
    }

    const activation = license.activations.find(
      (a) => a.deviceId === deviceId
    );

    if (!activation) {
      return res.status(403).json({ valid: false });
    }

    activation.lastSeen = new Date();
    await license.save();

    res.json({ valid: true });
  } catch (err) {
    res.status(500).json({ valid: false });
  }
};

const blockLicense = async (req, res) => {
  const { licenseId } = req.params;

  await License.findByIdAndUpdate(licenseId, {
    status: "blocked",
  });

  res.json({ success: true });
};

module.exports = {
  activateLicense,
  validateLicense,
  blockLicense,
};