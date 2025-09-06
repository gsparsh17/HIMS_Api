// const express = require('express');
// const router = express.Router();
// const customerController = require('../controllers/customer.controller');

// // This function now receives the models and returns the configured router
// module.exports = (Customer, Medicine) => {
//   // Pass the models to the controller function when the route is called
//   router.post('/', (req, res) => customerController.createCustomer(req, res, Customer, Medicine));

//   return router;
// };


const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer.controller');

// This now correctly points to the createCustomer function in your controller
router.post('/', customerController.createCustomer);
router.get('/', customerController.getAllCustomers);
router.get('/:id', customerController.getCustomerById);
router.put('/:id', customerController.updateCustomer);
router.delete('/:id', customerController.deleteCustomer);
router.get('/stats/summary', customerController.getCustomerStatistics);


module.exports = router;