const Supplier = require('../models/Supplier.js');

// @desc    Create a new supplier
// @route   POST /api/suppliers
// @access  Private (Admin)
const createSupplier = async (req, res) => {
  const { name, companyName, contactPerson, phone, email, address } = req.body; // ADDED companyName
  try {
    const supplierExists = await Supplier.findOne({ $or: [{ email }, { phone }] });
    if (supplierExists) {
      return res.status(400).json({ message: 'Supplier with this email or phone already exists.' });
    }
    const supplier = new Supplier({ name, companyName, contactPerson, phone, email, address }); // ADDED companyName
    const createdSupplier = await supplier.save();
    res.status(201).json(createdSupplier);
  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not create supplier.' });
  }
};

// @desc    Get all active suppliers
// @route   GET /api/suppliers
// @access  Private
const getAllSuppliers = async (req, res) => {
  try {
    const suppliers = await Supplier.find({ isActive: true });
    res.status(200).json(suppliers);
  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not fetch suppliers.' });
  }
};

// @desc    Get a single supplier by ID
// @route   GET /api/suppliers/:id
// @access  Private
const getSupplierById = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (supplier) {
      res.status(200).json(supplier);
    } else {
      res.status(404).json({ message: 'Supplier not found.' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not fetch supplier.' });
  }
};

// @desc    Update a supplier's details
// @route   PUT /api/suppliers/:id
// @access  Private (Admin)
const updateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier not found.' });
    }
    const { name, companyName, contactPerson, phone, email, address } = req.body; // ADDED companyName
    supplier.name = name || supplier.name;
    supplier.companyName = companyName || supplier.companyName; // ADDED
    supplier.contactPerson = contactPerson || supplier.contactPerson;
    supplier.phone = phone || supplier.phone;
    supplier.email = email || supplier.email;
    supplier.address = address || supplier.address;
    const updatedSupplier = await supplier.save();
    res.status(200).json(updatedSupplier);
  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not update supplier.' });
  }
};
// @desc    Deactivate a supplier (soft delete)
// @route   DELETE /api/suppliers/:id
// @access  Private (Admin)
const deactivateSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier not found.' });
    }
    supplier.isActive = false;
    await supplier.save();
    res.status(200).json({ message: 'Supplier deactivated successfully.' });
  } catch (error) {
    res.status(500).json({ message: 'Server Error: Could not deactivate supplier.' });
  }
};

module.exports = {
  createSupplier,
  getAllSuppliers,
  getSupplierById,
  updateSupplier,
  deactivateSupplier
};