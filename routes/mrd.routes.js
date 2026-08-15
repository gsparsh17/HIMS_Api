const express = require('express');
const controller = require('../controllers/mrd.controller');
const { authorize, requireModuleAccess } = require('../middlewares/auth');

const router = express.Router();
router.use(authorize('admin', 'mediqliq_super_admin', 'staff', 'registrar', 'receptionist', 'doctor', 'nurse', 'insurance_desk'));
router.use(requireModuleAccess('reports', 'view'));

router.get('/lookup/patients', controller.lookupPatients);
router.get('/lookup/doctors', controller.lookupDoctors);
router.get('/lookup/departments', controller.lookupDepartments);
router.get('/summary', controller.summary);
router.get('/ipd-records', controller.ipdRecords);
router.get('/opd-records', controller.opdRecords);
router.get('/discharges', controller.discharges);
router.get('/incomplete-records', controller.incompleteRecords);
router.patch('/incomplete-records/:admissionId', requireModuleAccess('reports', 'manage'), controller.updateIncompleteReview);
router.get('/documents', controller.documents);

router.get('/file-tracking', controller.fileTrackingList);
router.post('/file-tracking', requireModuleAccess('reports', 'manage'), controller.fileTrackingCreate);
router.post('/file-tracking/:id/movement', requireModuleAccess('reports', 'manage'), controller.fileTrackingMove);

router.get('/birth-death', controller.birthDeathList);
router.post('/birth-death', requireModuleAccess('reports', 'manage'), controller.birthDeathCreate);
router.patch('/birth-death/:id', requireModuleAccess('reports', 'manage'), controller.birthDeathUpdate);
router.get('/birth-death/:id/pdf', controller.birthDeathPdf);

router.get('/mlc', controller.mlcList);
router.post('/mlc', requireModuleAccess('reports', 'manage'), controller.mlcCreate);
router.patch('/mlc/:id', requireModuleAccess('reports', 'manage'), controller.mlcUpdate);

router.get('/certificates', controller.certificateList);
router.post('/certificates', requireModuleAccess('reports', 'manage'), controller.certificateCreate);
router.patch('/certificates/:id', requireModuleAccess('reports', 'manage'), controller.certificateUpdate);
router.get('/certificates/:id/pdf', controller.certificatePdf);

router.get('/exports/:section', controller.exportSection);

router.get('/reports/catalog', controller.reportCatalog);
router.get('/reports/:key', controller.report);

module.exports = router;
