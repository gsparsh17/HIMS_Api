// In your backend router file (e.g., /routes/paymentRoutes.js)
const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const Patient = require('../models/Patient'); // Assuming you have a Patient model

// Endpoint to create a Razorpay order and QR code
router.post('/create-qr-order', async (req, res) => {
  try {
    const { amount, patientId } = req.body;

    // Fetch patient details from your database to ensure data integrity
    const patientDetails = await Patient.findById(patientId);
    if (!patientDetails) {
      return res.status(404).json({ error: "Patient not found" });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    // 1. Create a Razorpay order
    const orderOptions = {
      amount: amount * 100, // Amount in paisa
      currency: "INR",
      receipt: `receipt_appointment_${Date.now()}`,
    };
    const order = await razorpay.orders.create(orderOptions);

    // 2. Create a UPI QR Code linked to the order
    const qrResponse = await razorpay.qrCode.create({
      type: "upi_qr",
      name: "Hospital Appointment Fee",
      usage: "single_use",
      fixed_amount: true,
      payment_amount: amount * 100,
      description: `Payment for ${patientDetails.first_name}`,
      notes: {
        order_id: order.id,
        patient_id: patientId,
      },
      // QR code expires in 10 minutes (600 seconds)
      close_by: Math.floor(Date.now() / 1000) + 600, 
    });

    res.status(200).json({
      orderId: order.id,
      qrImageUrl: qrResponse.image_url,
    });

  } catch (error) {
    console.error("Error creating Razorpay QR order:", error);
    res.status(500).json({ error: "Failed to create QR order" });
  }
});

// In the same backend router file

// Endpoint to check the status of a Razorpay order
router.get('/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const order = await razorpay.orders.fetch(orderId);

    res.status(200).json({ status: order.status }); // e.g., 'created', 'paid', 'attempted'

  } catch (error) {
    console.error("Error fetching order status:", error);
    res.status(500).json({ error: "Failed to fetch order status" });
  }
});

// ADD THIS LINE
module.exports = router;