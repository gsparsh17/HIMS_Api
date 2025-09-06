const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema({
  medicine_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Medicine', 
    required: true 
  },
  batch_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'MedicineBatch' 
  },
  quantity: { type: Number, required: true, min: 1 },
  unit_price: { type: Number, required: true },
  total_price: { type: Number, required: true },
  discount: { type: Number, default: 0 }
});

const saleSchema = new mongoose.Schema({
  sale_number: { type: String, required: true, unique: true },
  patient_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Patient' 
  },
  customer_name: { type: String }, // For walk-in customers
  customer_phone: { type: String },
  sale_date: { type: Date, default: Date.now },
  items: [saleItemSchema],
  subtotal: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total_amount: { type: Number, required: true },
  payment_method: { 
    type: String, 
    enum: ['Cash', 'Card', 'UPI', 'Net Banking', 'Insurance'], 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['Completed', 'Pending', 'Cancelled', 'Refunded'], 
    default: 'Completed' 
  },
  prescription_required: { type: Boolean, default: false },
  prescription_details: { type: String },
  created_by: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  }
}, { timestamps: true });

// Generate sale number before saving
saleSchema.pre('save', async function(next) {
  if (this.isNew) {
    const count = await mongoose.model('Sale').countDocuments();
    this.sale_number = `SALE-${Date.now()}-${count + 1}`;
  }
  next();
});

module.exports = mongoose.model('Sale', saleSchema);