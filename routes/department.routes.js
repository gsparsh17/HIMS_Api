const express = require('express');
const router = express.Router();
const controller = require('../controllers/department.controller');

router.post('/', controller.createDepartment);
router.get('/', controller.getAllDepartments);
router.get('/:id', controller.getDepartmentById);
router.put('/:id', controller.updateDepartment);
router.delete('/:id', controller.deleteDepartment);




module.exports = router;
