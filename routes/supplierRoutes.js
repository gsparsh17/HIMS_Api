const express = require('express');
const router = express.Router();
const {
  createSupplier,
  getAllSuppliers,
  getSupplierById,
  updateSupplier,
  deactivateSupplier
} = require('../controllers/supplierController.js');

// Chain routes for the base endpoint: /api/suppliers
router.route('/')
  .post(createSupplier)
  .get(getAllSuppliers);

// Chain routes for endpoints with an ID: /api/suppliers/:id
router.route('/:id')
  .get(getSupplierById)
  .put(updateSupplier)
  .delete(deactivateSupplier);

module.exports = router;