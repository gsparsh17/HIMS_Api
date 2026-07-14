require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI).then(async () => {
  try {
    const Hospital = require('../models/Hospital');
    const User = require('../models/User');
    const hospital = await Hospital.findOne();
    if (hospital) {
      const res = await User.updateMany(
        { hospital_id: { $exists: false } }, 
        { $set: { hospital_id: hospital._id } }
      );
      console.log('Fixed users:', res.modifiedCount);
    } else {
      console.log('No hospital found!');
    }
  } catch (e) {
    console.error(e.message);
  }
  process.exit(0);
});
