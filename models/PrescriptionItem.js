// // const mongoose = require('mongoose');

// // const prescriptionItemSchema = new mongoose.Schema({
// //   prescription_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription', required: true },
// //   medicine_name: { type: String, required: true },
// //   dosage: { type: String, required: true },
// //   duration: { type: String, required: true },
// //   instructions: { type: String }
// // });

// // module.exports = mongoose.model('PrescriptionItem', prescriptionItemSchema);



// const mongoose = require('mongoose');

// const prescriptionItemSchema = new mongoose.Schema({
//   prescription_id: { 
//     type: mongoose.Schema.Types.ObjectId, 
//     ref: 'Prescription', 
//     required: true 
//   },
//   // --- CHANGE THIS ---
//   // We now store a reference to the actual medicine, not just its name.
//   medicine_id: { 
//     type: mongoose.Schema.Types.ObjectId, 
//     ref: 'Medicine', // This points to your new Medicine.js model
//     required: true 
//   },
//   dosage: { type: String, required: true },
//   frequency: { type: String, required: true }, // Added frequency for completeness
//   duration: { type: String, required: true },
//   instructions: { type: String }
// });

// module.exports = mongoose.model('PrescriptionItem', prescriptionItemSchema);



const mongoose = require('mongoose');

const prescriptionItemSchema = new mongoose.Schema({
  prescription_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Prescription', 
    required: true 
  },
  medicine_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Medicine',
    required: true 
  },
  dosage: { type: String, required: true },
  frequency: { type: String, required: true }, // Ensure this line exists and is required
  duration: { type: String, required: true },
  instructions: { type: String }
});

module.exports = mongoose.model('PrescriptionItem', prescriptionItemSchema);