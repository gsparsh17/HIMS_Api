const express = require('express');
const router = express.Router();
const equipmentController = require('../controllers/equipment.controller');
const { verifyToken, authorize } = require('../middlewares/auth');

const equipmentAccess = [
  verifyToken,
  authorize('admin', 'mediqliq_super_admin', 'hr', 'hr_manager', 'store', 'store_manager', 'inventory_manager', 'accountant', 'equipment_manager')
];

router.post('/auth/login', equipmentController.equipmentLogin);

router.get('/dashboard', equipmentAccess, equipmentController.getDashboard);
router.get('/maintenance', equipmentAccess, equipmentController.getMaintenanceRecords);

router.post('/', equipmentAccess, equipmentController.createEquipment);
router.get('/', equipmentAccess, equipmentController.getEquipment);
router.get('/:id', equipmentAccess, equipmentController.getEquipmentById);
router.put('/:id', equipmentAccess, equipmentController.updateEquipment);
router.delete('/:id', equipmentAccess, equipmentController.deactivateEquipment);
router.put('/:id/condition', equipmentAccess, equipmentController.updateCondition);
router.put('/:id/assign', equipmentAccess, equipmentController.assignEquipment);
router.post('/:id/maintenance', equipmentAccess, equipmentController.addMaintenanceRecord);

module.exports = router;
