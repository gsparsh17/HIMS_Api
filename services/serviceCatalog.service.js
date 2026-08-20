const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const Procedure = require('../models/Procedure');
const HospitalCharges = require('../models/HospitalCharges');
const { userHospitalId } = require('../utils/hospitalScope');

function clean(value) { return String(value || '').trim(); }
function regex(value) { return new RegExp(clean(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
function dto({ serviceType, row, name, code, rate, category, source }) {
  return {
    serviceType,
    masterId: row?._id || null,
    code: clean(code),
    name: clean(name),
    aliases: [],
    department: row?.department_id || null,
    category: clean(category || row?.category),
    internalServiceModel: source === 'LabTest' ? 'LabTest' : source === 'ImagingTest' ? 'ImagingTest' : source === 'Procedure' ? 'Procedure' : undefined,
    internalServiceId: row?._id || null,
    defaultRate: Number(rate || 0),
    taxProfile: { mode: 'exclusive', rate: 0 },
    billingPolicy: serviceType === 'MANUAL' ? 'PERMISSION_REQUIRED' : 'STANDARD',
    active: row?.is_active !== false,
    source
  };
}

async function searchServiceCatalog({ user, query, encounterType = 'OPD', limit = 30 }) {
  const hospitalId = userHospitalId(user);
  if (!hospitalId) throw Object.assign(new Error('Hospital context is required'), { statusCode: 400 });
  const q = clean(query);
  const match = q ? regex(q) : /.*/i;
  const capped = Math.min(Math.max(Number(limit) || 30, 1), 60);

  const [labs, imaging, procedures, charges] = await Promise.all([
    LabTest.find({ hospitalId, is_active: { $ne: false }, $or: [{ name: match }, { code: match }, { category: match }] }).limit(capped).lean(),
    ImagingTest.find({ hospitalId, is_active: { $ne: false }, $or: [{ name: match }, { code: match }, { category: match }] }).limit(capped).lean(),
    Procedure.find({ hospitalId, is_active: { $ne: false }, $or: [{ name: match }, { code: match }, { category: match }] }).limit(capped).lean(),
    HospitalCharges.findOne({ hospital: hospitalId }).sort({ effectiveFrom: -1 }).lean()
  ]);

  const rows = [
    ...labs.map(row => dto({ serviceType: 'LAB', row, name: row.name, code: row.code, rate: row.base_price, category: row.category, source: 'LabTest' })),
    ...imaging.map(row => dto({ serviceType: 'RADIOLOGY', row, name: row.name, code: row.code, rate: row.base_price, category: row.category, source: 'ImagingTest' })),
    ...procedures.map(row => dto({ serviceType: 'PROCEDURE', row, name: row.name, code: row.code, rate: row.base_price, category: row.category, source: 'Procedure' }))
  ];
  const configRows = encounterType === 'IPD' ? [
    ['REGISTRATION', 'IPD-REG', 'IPD Registration Fee', charges?.ipdCharges?.registrationFee],
    ['ADMISSION', 'IPD-ADM', 'Admission Fee', charges?.ipdCharges?.admissionFee],
    ['CONSULTATION', 'IPD-CONS', 'IPD Consultation Fee', charges?.ipdCharges?.consultationFee],
    ['NURSING', 'IPD-NURS', 'Nursing Charges', charges?.ipdCharges?.nursingCharges],
    ['OT', 'IPD-OT', 'Operation Theatre Charges', charges?.ipdCharges?.otCharges]
  ] : [
    ['REGISTRATION', 'OPD-REG', 'OPD Registration Fee', charges?.opdCharges?.registrationFee],
    ['CONSULTATION', 'OPD-CONS', 'OPD Consultation Fee', charges?.opdCharges?.consultationFee]
  ];
  configRows.forEach(([serviceType, code, name, rate]) => {
    if ((!q || match.test(name) || match.test(code)) && Number(rate || 0) >= 0) rows.push(dto({ serviceType, name, code, rate, source: 'HospitalCharges' }));
  });

  return rows
    .sort((a, b) => {
      const ax = a.code.toLowerCase() === q.toLowerCase() || a.name.toLowerCase() === q.toLowerCase() ? 0 : 1;
      const bx = b.code.toLowerCase() === q.toLowerCase() || b.name.toLowerCase() === q.toLowerCase() ? 0 : 1;
      return ax - bx || a.name.localeCompare(b.name);
    })
    .slice(0, capped);
}

module.exports = { searchServiceCatalog };
