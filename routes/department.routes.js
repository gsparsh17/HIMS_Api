const express = require('express');
const router = express.Router();
const controller = require('../controllers/department.controller');

router.post('/', controller.createDepartment);
router.get('/', controller.getAllDepartments);
router.get('/id/:name', controller.getDepartmentIdByName);
router.get('/:id', controller.getDepartmentById);
router.put('/:id', controller.updateDepartment);
router.delete('/:id', controller.deleteDepartment);
router.get('/hods/all', controller.getAllHods); 



module.exports = router;
