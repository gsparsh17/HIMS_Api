
const Hospital = require('../models/Hospital.js');

const getHospitalDetails = async (req, res) => {
  try {
    const hospital = await Hospital.find({});
    if (!hospital.length) {
      return res.status(404).json({ message: 'No hospital details found.' });
    }
    res.status(200).json(hospital);
  } catch (error) {
    console.error("Error fetching hospital details:", error);
    res.status(500).json({ message: 'Server error while fetching hospital details.' });
  }
};

module.exports = {
  getHospitalDetails,
};