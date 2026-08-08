'use strict';

const ClinicalOrderSet = require('../models/ClinicalOrderSet');
const Medicine = require('../models/Medicine');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const Prescription = require('../models/Prescription');
const LabRequest = require('../models/LabRequest');
const RadiologyRequest = require('../models/RadiologyRequest');
const ProcedureRequest = require('../models/ProcedureRequest');
const { hospitalId, required, sendError } = require('../utils/functionalDomain');

function storedPriority(value) {
  const raw = String(value || 'routine').trim().toLowerCase();

  if (raw === 'emergency') {
    return 'stat';
  }

  return ['routine', 'urgent', 'stat'].includes(raw) ? raw : 'routine';
}

function downstreamPriority(orderType, value) {
  const raw = storedPriority(value);

  if (orderType === 'laboratory') {
    if (raw === 'stat') return 'Stat';
    if (raw === 'urgent') return 'Urgent';
    return 'Routine';
  }

  if (['radiology', 'procedure'].includes(orderType)) {
    if (raw === 'stat') return 'Emergency';
    if (raw === 'urgent') return 'Urgent';
    return 'Routine';
  }

  return raw;
}

const masterMap = {
  medication: {
    Model: Medicine,
    fields: 'name generic_name brand strength medicationSafety',
    code: 'name'
  },
  laboratory: {
    Model: LabTest,
    fields: 'name code category critical_low critical_high units specimen_type',
    code: 'code'
  },
  radiology: {
    Model: ImagingTest,
    fields: 'name code category preparation_instructions',
    code: 'code'
  },
  procedure: {
    Model: Procedure,
    fields: 'name code category description base_price',
    code: 'code'
  }
};

async function resolveItem(req, item) {
  const spec = masterMap[item.orderType];

  if (!spec) {
    const e = new Error('Invalid orderType');
    e.statusCode = 400;
    throw e;
  }

  const q = {
    _id: item.masterId
  };

  if (spec.Model.schema.path('hospitalId')) {
    q.hospitalId = hospitalId(req);
  }

  if (spec.Model.schema.path('hospital_id')) {
    q.hospital_id = hospitalId(req);
  }

  const row = await spec.Model
    .findOne(q)
    .select(spec.fields)
    .lean();

  if (!row) {
    const e = new Error(`${item.orderType} master not found`);
    e.statusCode = 404;
    throw e;
  }

  return {
    orderType: item.orderType,
    masterId: row._id,
    code: row.code || row.name,
    name: row.name,
    priority: storedPriority(item.priority),
    defaults: item.defaults || {},
    master: row
  };
}

exports.catalogue = async (req, res) => {
  try {
    const hid = hospitalId(req);
    const search = String(req.query.search || '').trim();
    const rx = search
      ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;

    const searchFilter = rx
      ? {
          $or: [
            { name: rx },
            { generic_name: rx },
            { brand: rx }
          ]
        }
      : {};

    const [
      medications,
      laboratory,
      radiology,
      procedures
    ] = await Promise.all([
      Medicine.find({
        hospitalId: hid,
        is_active: true,
        ...searchFilter
      })
        .select(masterMap.medication.fields)
        .limit(100)
        .lean(),

      LabTest.find({
        hospitalId: hid,
        is_active: true,
        ...(rx
          ? { $or: [{ name: rx }, { code: rx }] }
          : {})
      })
        .select(masterMap.laboratory.fields)
        .limit(100)
        .lean(),

      ImagingTest.find({
        hospitalId: hid,
        is_active: true,
        ...(rx
          ? { $or: [{ name: rx }, { code: rx }] }
          : {})
      })
        .select(masterMap.radiology.fields)
        .limit(100)
        .lean(),

      Procedure.find({
        hospitalId: hid,
        ...(rx
          ? { $or: [{ name: rx }, { code: rx }] }
          : {})
      })
        .select(masterMap.procedure.fields)
        .limit(100)
        .lean()
    ]);

    return res.json({
      success: true,
      data: {
        medications,
        laboratory,
        radiology,
        procedures
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};

exports.create = async (req, res) => {
  try {
    required(req.body, ['name']);

    if (!Array.isArray(req.body.items) || !req.body.items.length) {
      return res.status(400).json({
        error: 'items are required'
      });
    }

    const items = [];

    for (const item of req.body.items) {
      items.push(await resolveItem(req, item));
    }

    const row = await ClinicalOrderSet.create({
      hospitalId: hospitalId(req),
      name: req.body.name,
      diagnosisCodes: (req.body.diagnosisCodes || [])
        .map(x => String(x).toUpperCase()),
      items: items.map(({ master, ...x }) => x),
      createdBy: req.user._id,
      updatedBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.update = async (req, res) => {
  try {
    const row = await ClinicalOrderSet.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req)
    });

    if (!row) {
      return res.status(404).json({
        error: 'Order set not found'
      });
    }

    if (req.body.name) {
      row.name = req.body.name;
    }

    if (req.body.diagnosisCodes) {
      row.diagnosisCodes = req.body.diagnosisCodes;
    }

    if (req.body.items) {
      const items = [];

      for (const item of req.body.items) {
        items.push(await resolveItem(req, item));
      }

      row.items = items.map(({ master, ...x }) => x);
    }

    row.updatedBy = req.user._id;
    await row.save();

    return res.json({
      success: true,
      data: row
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.apply = async (req, res) => {
  try {
    required(req.body, ['patientId']);

    const set = await ClinicalOrderSet.findOne({
      _id: req.params.id,
      hospitalId: hospitalId(req),
      active: true
    });

    if (!set) {
      return res.status(404).json({
        error: 'Order set not found'
      });
    }

    const diagnosisCode = String(
      req.body.diagnosisCode || set.diagnosisCodes?.[0] || ''
    ).toUpperCase();

    if (set.diagnosisCodes.length &&
        diagnosisCode &&
        !set.diagnosisCodes.includes(diagnosisCode)) {
      return res.status(409).json({
        error: 'Diagnosis code is not configured for this order set'
      });
    }

    const draft = {
      patient_id: req.body.patientId,
      appointment_id: req.body.appointmentId,
      doctor_id: req.body.doctorId,
      diagnosis: req.body.diagnosis || diagnosisCode,
      items: [],
      lab_test_requests: [],
      radiology_test_requests: [],
      procedure_requests: []
    };

    for (const i of set.items) {
      if (i.orderType === 'medication') {
        draft.items.push({
          medicine_id: i.masterId,
          medicine_name: i.name,
          generic_name: i.defaults?.generic_name || '',
          medicine_type: i.defaults?.medicine_type || 'Tablet',
          route_of_administration: i.defaults?.route_of_administration || 'Oral',
          dosage: i.defaults?.dosage || '1',
          frequency: i.defaults?.frequency || 'OD',
          duration: i.defaults?.duration || '1',
          instructions: i.defaults?.instructions || '',
          antimicrobial_justification: i.defaults?.antimicrobial_justification || '',
          antimicrobial_approval_reference: i.defaults?.antimicrobial_approval_reference || '',
          requires_pharmacy_dispense: i.defaults?.requires_pharmacy_dispense !== false
        });
      }

      if (i.orderType === 'laboratory') {
        draft.lab_test_requests.push({
          lab_test_id: i.masterId,
          lab_test_name: i.name,
          lab_test_code: i.code,
          priority: downstreamPriority('laboratory', i.priority),
          clinical_history: req.body.clinicalHistory || '',
          scheduled_date: req.body.scheduledDate
        });
      }

      if (i.orderType === 'radiology') {
        draft.radiology_test_requests.push({
          imaging_test_id: i.masterId,
          imaging_test_name: i.name,
          imaging_test_code: i.code,
          priority: downstreamPriority('radiology', i.priority),
          clinical_history: req.body.clinicalHistory || '',
          scheduled_date: req.body.scheduledDate
        });
      }

      if (i.orderType === 'procedure') {
        draft.procedure_requests.push({
          procedure_id: i.masterId,
          procedure_name: i.name,
          procedure_code: i.code,
          priority: downstreamPriority('procedure', i.priority),
          clinical_history: req.body.clinicalHistory || '',
          clinical_indication: req.body.clinicalIndication || '',
          scheduled_date: req.body.scheduledDate
        });
      }
    }

    return res.json({
      success: true,
      orderSet: {
        _id: set._id,
        name: set.name
      },
      prescriptionDraft: draft
    });
  } catch (e) {
    return sendError(res, e);
  }
};

exports.patientOrders = async (req, res) => {
  try {
    const hid = hospitalId(req);
    const pid = req.params.patientId;

    const [
      prescriptions,
      labs,
      radiology,
      procedures
    ] = await Promise.all([
      Prescription.find({
        hospitalId: hid,
        $or: [
          { patient_id: pid },
          { patientId: pid }
        ]
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),

      LabRequest.find({
        hospitalId: hid,
        patientId: pid
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),

      RadiologyRequest.find({
        hospitalId: hid,
        patientId: pid
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),

      ProcedureRequest.find({
        hospitalId: hid,
        patientId: pid
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean()
    ]);

    return res.json({
      success: true,
      data: {
        prescriptions,
        laboratory: labs,
        radiology,
        procedures
      }
    });
  } catch (e) {
    return sendError(res, e, 500);
  }
};