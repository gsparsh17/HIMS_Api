const express = require('express');
const router = express.Router();
const {
  createSupplier,
  getAllSuppliers,
  getSupplierById,
  updateSupplier,
  deactivateSupplier
} = require('../controllers/supplierController.js');
const supplierQuality = require('../controllers/supplierQuality.controller');

// Chain routes for the base endpoint: /api/suppliers
router.route('/')
  .post(createSupplier)
  .get(getAllSuppliers);

router.post('/:supplierId/quality-issues', supplierQuality.create);
router.get('/:supplierId/quality-issues', supplierQuality.list);
router.patch('/quality-issues/:id', supplierQuality.update);

// Chain routes for endpoints with an ID: /api/suppliers/:id
router.route('/:id')
  .get(getSupplierById)
  .put(updateSupplier)
  .delete(deactivateSupplier);

module.exports = router;