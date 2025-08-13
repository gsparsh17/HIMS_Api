// const Customer = require('../models/Customer');
// const Medicine = require('../models/Medicine');

// exports.createCustomer = async (req, res) => {
//   try {
//     const {
//       name, phone, email, address, medicineId, purchasedItemName,
//       purchasedQuantity, amount, paymentMode, status, description
//     } = req.body;

//     const medicine = await Medicine.findById(medicineId);
//     if (!medicine) {
//       return res.status(404).json({ error: 'Medicine not found.' });
//     }

//     if (medicine.stock_quantity < purchasedQuantity) {
//       return res.status(400).json({ error: 'Insufficient stock for the requested quantity.' });
//     }

//     medicine.stock_quantity -= purchasedQuantity;
//     await medicine.save();

//     const purchaseData = {
//       itemName: purchasedItemName,
//       quantity: purchasedQuantity,
//       amount,
//       paymentMode,
//       status
//     };

//     let customer = await Customer.findOne({ phone });
//     if (customer) {
//       customer.purchases.push(purchaseData);
//     } else {
//       customer = new Customer({
//         name, phone, email, address, description, purchases: [purchaseData]
//       });
//     }

//     await customer.save();

//     res.status(201).json({ message: 'Sale recorded and stock updated successfully', customer });

//   } catch (err) {
//     console.error("!!! Error in createCustomer:", err);
//     res.status(500).json({ error: 'An internal server error occurred.' });
//   }
// };


// In HIMS_Api/controllers/customer.controller.js

const Customer = require('../models/Customer');
const Medicine = require('../models/Medicine');

exports.createCustomer = async (req, res) => {
  try {
    const {
      name, phone, email, address,
      items, // Expect an array of items
      paymentMode, status, description
    } = req.body;

    const purchaseHistoryItems = [];
    let calculatedTotalAmount = 0;

    // Loop through each item to validate and update stock
    for (const item of items) {
      const medicine = await Medicine.findById(item.medicineId);

      if (!medicine) {
        return res.status(404).json({ error: `Medicine not found: ${item.medicineId}` });
      }
      if (medicine.stock_quantity < item.quantity) {
        return res.status(400).json({ error: `Insufficient stock for ${medicine.name}.` });
      }

      // Deduct stock
      medicine.stock_quantity -= item.quantity;
      await medicine.save();

      const itemTotal = item.quantity * medicine.price_per_unit;
      calculatedTotalAmount += itemTotal;

      // Prepare item for purchase history
      purchaseHistoryItems.push({
        itemName: medicine.name,
        quantity: item.quantity,
        amount: itemTotal,
        paymentMode,
        status,
      });
    }

    // Find existing customer or create a new one
    let customer = await Customer.findOne({ phone });
    if (customer) {
      customer.purchases.push(...purchaseHistoryItems);
    } else {
      customer = new Customer({
        name, phone, email, address, description,
        purchases: purchaseHistoryItems,
      });
    }

    await customer.save();
    res.status(201).json({ message: 'Sale recorded and stock updated successfully', customer });

  } catch (err) {
    console.error("Error in createCustomer:", err);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
};
// Get all customers
exports.getAllCustomers = async (req, res) => {
  try {
    const customers = await Customer.find().sort({ created_at: -1 });
    res.status(200).json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};