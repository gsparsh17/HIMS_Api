const crypto = require('crypto');
const ExcelJS = require('exceljs');
const BulkImportJob = require('../models/BulkImportJob');
const HRStaffProfile = require('../models/HRStaffProfile');
const Medicine = require('../models/Medicine');
const LabTest = require('../models/LabTest');
const ImagingTest = require('../models/ImagingTest');
const BillingServiceMaster = require('../models/BillingServiceMaster');
const Procedure = require('../models/Procedure'); // Add this import

const ENTITY = {
  employees: {
    title: 'Employee / HR Staff Master',
    sheet: 'Employees',
    key: 'employee_code',
    columns: [
      ['employee_code', 'Employee Code', true],
      ['first_name', 'First Name', true],
      ['last_name', 'Last Name', false],
      ['email', 'Email', true],
      ['phone', 'Phone', false],
      ['staff_type', 'Staff Type', true],
      ['designation', 'Designation', true],
      ['department_name', 'Department', false],
      ['joining_date', 'Joining Date', false],
      ['gender', 'Gender', false],
      ['employment_status', 'Employment Status', false],
      ['address', 'Address', false],
      ['login_required', 'Login Required', false],
      ['update_mode', 'Update Mode', false]
    ]
  },
  medicines: {
    title: 'Pharmacy Medicine Master',
    sheet: 'Medicines',
    key: 'name',
    columns: [
      ['name', 'Name', true],
      ['generic_name', 'Generic Name', false],
      ['brand', 'Brand', false],
      ['category', 'Category', true],
      ['strength', 'Strength', false],
      ['composition', 'Composition', false],
      ['manufacturer', 'Manufacturer', false],
      ['hsn_code', 'HSN Code', true],
      ['gst_rate', 'GST Rate', true],
      ['base_unit', 'Base Unit', false],
      ['pack_unit', 'Pack Unit', false],
      ['units_per_pack', 'Units Per Pack', false],
      ['allow_loose_sale', 'Allow Loose Sale', false],
      ['min_stock_level_base_units', 'Min Stock Level', false],
      ['prescription_required', 'Prescription Required', false],
      ['shelf', 'Shelf', false],
      ['rack', 'Rack', false],
      ['is_active', 'Is Active', false],
      ['update_mode', 'Update Mode', false]
    ]
  },
  'lab-tests': {
    title: 'Lab Test Master',
    sheet: 'Lab Tests',
    key: 'code',
    columns: [
      ['code', 'Code', true],
      ['name', 'Name', true],
      ['category', 'Category', true],
      ['subCategory', 'Sub Category', false],
      ['description', 'Description', false],
      ['specimen_type', 'Specimen Type', false],
      ['specimen_volume', 'Specimen Volume', false],
      ['container_type', 'Container Type', false],
      ['fasting_required', 'Fasting Required', false],
      ['fasting_hours', 'Fasting Hours', false],
      ['preparation_instructions', 'Preparation Instructions', false],
      ['turnaround_time_hours', 'TAT Hours', false],
      ['normal_range', 'Normal Range', false],
      ['critical_low', 'Critical Low', false],
      ['critical_high', 'Critical High', false],
      ['units', 'Units', false],
      ['base_price', 'Base Price', false],
      ['insurance_coverage', 'Insurance Coverage', false],
      ['is_active', 'Is Active', false],
      ['update_mode', 'Update Mode', false]
    ]
  },
  'radiology-tests': {
    title: 'Radiology / Imaging Test Master',
    sheet: 'Imaging Tests',
    key: 'code',
    columns: [
      ['code', 'Code', true],
      ['name', 'Name', true],
      ['category', 'Category', true],
      ['description', 'Description', false],
      ['preparation_instructions', 'Preparation Instructions', false],
      ['contraindications', 'Contraindications', false],
      ['contrast_required', 'Contrast Required', false],
      ['contrast_details', 'Contrast Details', false],
      ['turnaround_time_hours', 'TAT Hours', false],
      ['base_price', 'Base Price', false],
      ['insurance_coverage', 'Insurance Coverage', false],
      ['is_active', 'Is Active', false],
      ['update_mode', 'Update Mode', false]
    ]
  },
  charges: {
    title: 'Billing / Service Master',
    sheet: 'Charges',
    key: 'chargeCode',
    columns: [
      ['chargeCode', 'Charge Code', true],
      ['chargeName', 'Charge Name', true],
      ['category', 'Category', true],
      ['department', 'Department', false],
      ['serviceType', 'Service Type', true],
      ['unit', 'Unit', false],
      ['price', 'Price', true],
      ['taxRate', 'Tax Rate', false],
      ['active', 'Active', false],
      ['effectiveFrom', 'Effective From', false],
      ['effectiveTo', 'Effective To', false],
      ['notes', 'Notes', false],
      ['update_mode', 'Update Mode', false]
    ]
  },
  procedures: {
    title: 'Procedure Master',
    sheet: 'Procedures',
    key: 'code',
    columns: [
      ['code', 'Code', true],
      ['name', 'Name', true],
      ['category', 'Category', true],
      ['subcategory', 'Sub Category', false],
      ['description', 'Description', false],
      ['base_price', 'Base Price', false],
      ['duration_minutes', 'Duration (Minutes)', false],
      ['cpt_code', 'CPT Code', false],
      ['icd10_codes', 'ICD-10 Codes', false],
      ['equipment_required', 'Equipment Required', false],
      ['pre_procedure_instructions', 'Pre-Proc Instructions', false],
      ['post_procedure_instructions', 'Post-Proc Instructions', false],
      ['consent_required', 'Consent Required', false],
      ['facility_level', 'Facility Level', false],
      ['is_active', 'Is Active', false],
      ['update_mode', 'Update Mode', false]
    ]
  }
};

const bool = v => ['true', 'yes', '1', 'y'].includes(String(v ?? '').trim().toLowerCase());
const num = v => v === '' || v === undefined || v === null ? undefined : Number(v);
const cell = v => typeof v === 'string' ? v.trim() : v;
const safeSheet = v => /^[=+\-@]/.test(String(v || '')) ? `'${v}` : v;

function modelFor(entity) {
  return ({
    employees: HRStaffProfile,
    medicines: Medicine,
    'lab-tests': LabTest,
    'radiology-tests': ImagingTest,
    charges: BillingServiceMaster,
    procedures: Procedure
  })[entity];
}

function scopedQuery(entity, key, hospitalId) {
  const query = { hospitalId };
  
  switch(entity) {
    case 'employees':
      if (key) query.employee_code = key;
      break;
    case 'medicines':
      // Medicines use composite key, handled in existing() function
      break;
    case 'lab-tests':
    case 'radiology-tests':
    case 'procedures':
      if (key) query.code = key;
      break;
    case 'charges':
      if (key) query.chargeCode = key;
      break;
    default:
      break;
  }
  
  return query;
}

function normalize(entity, row, hospitalId, userId) {
  const str = k => cell(row[k]);

  if (entity === 'employees') {
    return {
      employee_code: String(str('employee_code') || '').toUpperCase(),
      full_name: [str('first_name'), str('last_name')].filter(Boolean).join(' ') || str('full_name'),
      first_name: str('first_name'),
      last_name: str('last_name'),
      email: String(str('email') || '').toLowerCase(),
      phone: str('phone'),
      staff_type: String(str('staff_type') || 'staff').toLowerCase(),
      designation: str('designation'),
      department_name: str('department_name') || str('department'),
      joining_date: str('joining_date') ? new Date(str('joining_date')) : undefined,
      gender: String(str('gender') || '').toLowerCase() || undefined,
      employment_status: str('employment_status') || 'Active',
      address: str('address'),
      login_enabled: bool(str('login_required')),
      hospital_id: hospitalId,
      created_by: userId,
      updated_by: userId
    };
  }

  if (entity === 'medicines') {
    return {
      hospitalId,
      name: str('name'),
      generic_name: str('generic_name'),
      brand: str('brand'),
      category: str('category'),
      strength: str('strength'),
      composition: str('composition'),
      manufacturer: str('manufacturer'),
      hsn_code: String(str('hsn_code') || ''),
      gst_rate: num(str('gst_rate')),
      base_unit: str('base_unit') || 'tablet',
      pack_unit: str('pack_unit') || 'strip',
      units_per_pack: num(str('units_per_pack')) || 1,
      allow_loose_sale: bool(str('allow_loose_sale')),
      min_stock_level_base_units: num(str('min_stock_level_base_units')) || 0,
      prescription_required: bool(str('prescription_required')),
      location: {
        shelf: str('shelf'),
        rack: str('rack')
      },
      is_active: str('is_active') === '' ? true : bool(str('is_active'))
    };
  }

  if (entity === 'lab-tests') {
    return {
      hospitalId,
      code: String(str('code') || '').toUpperCase(),
      name: str('name'),
      category: str('category'),
      subCategory: str('subCategory'),
      description: str('description'),
      specimen_type: str('specimen_type') || 'Blood',
      specimen_volume: str('specimen_volume'),
      container_type: str('container_type'),
      fasting_required: bool(str('fasting_required')),
      fasting_hours: num(str('fasting_hours')) || 0,
      preparation_instructions: str('preparation_instructions'),
      turnaround_time_hours: num(str('turnaround_time_hours')) || 24,
      normal_range: str('normal_range'),
      critical_low: str('critical_low'),
      critical_high: str('critical_high'),
      units: str('units'),
      base_price: num(str('base_price')) || 0,
      insurance_coverage: str('insurance_coverage') || 'Partial',
      is_active: str('is_active') === '' ? true : bool(str('is_active')),
      createdBy: userId
    };
  }

  if (entity === 'radiology-tests') {
    return {
      hospitalId,
      code: String(str('code') || '').toUpperCase(),
      name: str('name'),
      category: str('category'),
      description: str('description'),
      preparation_instructions: str('preparation_instructions'),
      contraindications: str('contraindications'),
      contrast_required: bool(str('contrast_required')),
      contrast_details: str('contrast_details'),
      turnaround_time_hours: num(str('turnaround_time_hours')) || 24,
      base_price: num(str('base_price')) || 0,
      insurance_coverage: str('insurance_coverage') || 'Partial',
      is_active: str('is_active') === '' ? true : bool(str('is_active')),
      createdBy: userId
    };
  }

  if (entity === 'procedures') {
    // Parse comma-separated strings into arrays
    const parseArray = (val) => {
      if (!val) return [];
      return String(val).split(',').map(s => s.trim()).filter(Boolean);
    };

    return {
      code: String(str('code') || '').toUpperCase(),
      name: str('name'),
      category: str('category'),
      subcategory: str('subcategory'),
      description: str('description'),
      base_price: num(str('base_price')) || 0,
      duration_minutes: num(str('duration_minutes')) || 30,
      cpt_code: str('cpt_code'),
      icd10_codes: parseArray(str('icd10_codes')),
      equipment_required: parseArray(str('equipment_required')),
      pre_procedure_instructions: str('pre_procedure_instructions'),
      post_procedure_instructions: str('post_procedure_instructions'),
      consent_required: str('consent_required') === '' ? true : bool(str('consent_required')),
      facility_level: parseArray(str('facility_level')),
      is_active: str('is_active') === '' ? true : bool(str('is_active')),
      created_by: userId
    };
  }

  // Default: charges
  return {
    hospitalId,
    chargeCode: String(str('chargeCode') || '').toUpperCase(),
    chargeName: str('chargeName'),
    category: str('category'),
    departmentName: str('department'),
    serviceType: str('serviceType'),
    unit: str('unit') || 'Each',
    price: num(str('price')),
    taxRate: num(str('taxRate')) || 0,
    active: str('active') === '' ? true : bool(str('active')),
    effectiveFrom: str('effectiveFrom') ? new Date(str('effectiveFrom')) : new Date(),
    effectiveTo: str('effectiveTo') ? new Date(str('effectiveTo')) : undefined,
    notes: str('notes'),
    createdBy: userId,
    updatedBy: userId
  };
}

function validate(entity, data) {
  const e = [];
  const required = {
    employees: ['employee_code', 'full_name', 'email', 'staff_type', 'designation'],
    medicines: ['name', 'category', 'hsn_code', 'gst_rate'],
    'lab-tests': ['code', 'name', 'category'],
    'radiology-tests': ['code', 'name', 'category'],
    charges: ['chargeCode', 'chargeName', 'category', 'serviceType', 'price'],
    procedures: ['code', 'name', 'category']
  }[entity];

  if (required) {
    required.forEach(k => {
      if (data[k] === undefined || data[k] === null || data[k] === '') {
        e.push(`${k} is required`);
      }
    });
  }

  if (entity === 'medicines') {
    if (data.hsn_code && !/^\d{4,8}$/.test(String(data.hsn_code))) {
      e.push('hsn_code must be 4-8 digits');
    }
    if (data.gst_rate !== undefined && ![0, 5, 12, 18, 28].includes(Number(data.gst_rate))) {
      e.push('gst_rate must be 0, 5, 12, 18 or 28');
    }
  }

  // Common numeric validations
  ['price', 'base_price', 'turnaround_time_hours', 'taxRate', 'duration_minutes'].forEach(k => {
    if (data[k] !== undefined && data[k] !== null && data[k] !== '') {
      if (!Number.isFinite(Number(data[k])) || Number(data[k]) < 0) {
        e.push(`${k} must be a non-negative number`);
      }
    }
  });

  // Procedure-specific validations
  if (entity === 'procedures') {
    if (data.duration_minutes !== undefined && data.duration_minutes !== null && data.duration_minutes !== '') {
      if (Number(data.duration_minutes) < 1) {
        e.push('duration_minutes must be at least 1');
      }
    }
    
    // Validate facility_level values if provided
    if (data.facility_level && Array.isArray(data.facility_level)) {
      const validLevels = ['Primary', 'Secondary', 'Tertiary'];
      const invalidLevels = data.facility_level.filter(l => !validLevels.includes(l));
      if (invalidLevels.length > 0) {
        e.push(`facility_level must be one of: ${validLevels.join(', ')}. Invalid values: ${invalidLevels.join(', ')}`);
      }
    }
  }

  // Email validation for employees
  if (data.email && !/^\S+@\S+\.\S+$/.test(data.email)) {
    e.push('email is invalid');
  }

  // Category validations for lab tests and radiology
  if (entity === 'lab-tests' && data.category) {
    const validCategories = [
      'Hematology', 'Biochemistry', 'Microbiology', 'Immunology', 
      'Pathology', 'Serology', 'Toxicology', 'Endocrinology', 
      'Cardiology', 'Molecular Diagnostics', 'Genetic Testing', 'Other'
    ];
    if (!validCategories.includes(data.category)) {
      e.push(`category must be one of: ${validCategories.join(', ')}`);
    }
  }

  if (entity === 'radiology-tests' && data.category) {
    const validCategories = [
      'X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'ECG', 
      'Echocardiography', 'Mammography', 'PET Scan', 'DEXA Scan', 
      'Fluoroscopy', 'Angiography', 'Other'
    ];
    if (!validCategories.includes(data.category)) {
      e.push(`category must be one of: ${validCategories.join(', ')}`);
    }
  }

  if (entity === 'procedures' && data.category) {
    const validCategories = [
      'Diagnostic', 'Preventive', 'Restorative', 'Endodontics', 
      'Periodontics', 'Prosthodontics', 'Implant', 'Oral Surgery',
      'Orthodontics', 'Adjunctive', 'Radiology', 'Laboratory',
      'Anesthesia', 'Emergency', 'Consultation', 'Follow-up',
      'Other'
    ];
    if (!validCategories.includes(data.category)) {
      e.push(`category must be one of: ${validCategories.join(', ')}`);
    }
  }

  return e;
}

function natural(entity, data) {
  if (entity === 'employees') {
    return data.employee_code || `${data.first_name || ''}_${data.last_name || ''}_${data.email || ''}`;
  }

  if (entity === 'medicines') {
    return [data.name, data.strength || '', data.brand || '', data.generic_name || '', data.composition || '']
      .map(v => String(v).toLowerCase())
      .join('|');
  }

  if (entity === 'charges') {
    return `${data.chargeCode}|${data.effectiveFrom ? new Date(data.effectiveFrom).toISOString().slice(0, 10) : 'unknown'}`;
  }

  if (entity === 'procedures') {
    return data.code;
  }

  // lab-tests and radiology-tests
  return data.code;
}

async function existing(entity, data, hospitalId) {
  const M = modelFor(entity);
  if (!M) return null;

  if (entity === 'employees') {
    return M.findOne({ hospital_id: hospitalId, employee_code: data.employee_code });
  }

  if (entity === 'medicines') {
    return M.findOne({
      hospitalId: hospitalId,
      name: data.name,
      strength: data.strength || '',
      brand: data.brand || '',
      generic_name: data.generic_name || '',
      composition: data.composition || ''
    });
  }

  if (entity === 'charges') {
    return M.findOne({ 
      hospitalId: hospitalId, 
      chargeCode: data.chargeCode, 
      effectiveFrom: data.effectiveFrom 
    });
  }

  if (entity === 'procedures') {
    return M.findOne({ 
      code: data.code 
    });
  }

  // lab-tests and radiology-tests
  return M.findOne({ hospitalId: hospitalId, code: data.code });
}

async function rowsFromFile(file) {
  const wb = new ExcelJS.Workbook();
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();

  try {
    if (ext === 'csv') {
      await wb.csv.load(file.buffer);
    } else {
      await wb.xlsx.load(file.buffer);
    }
  } catch (error) {
    throw new Error(`Failed to parse file: ${error.message}`);
  }

  const ws = wb.worksheets[0];
  if (!ws) {
    throw new Error('Workbook must contain a data sheet');
  }

  // Get headers from first row
  const headers = [];
  const firstRow = ws.getRow(1);
  firstRow.eachCell((cell, colNumber) => {
    const header = String(cell.value || '').trim();
    if (header) {
      headers[colNumber - 1] = header;
    }
  });

  // Filter out empty headers
  const validHeaders = headers.filter(h => h);
  
  if (validHeaders.length === 0) {
    throw new Error('No headers found in the first row');
  }

  const rows = [];

  ws.eachRow((r, n) => {
    if (n === 1) return;

    const out = {};
    let hasData = false;
    
    validHeaders.forEach((h, i) => {
      const cellValue = r.getCell(i + 1).value;
      const value = cellValue?.text !== undefined ? cellValue.text : 
                   cellValue?.result !== undefined ? cellValue.result : 
                   cellValue;
      out[h] = value !== undefined && value !== null ? String(value).trim() : '';
      if (out[h] !== '') hasData = true;
    });

    if (hasData) {
      rows.push({ rowNumber: n, row: out });
    }
  });

  return { headers: validHeaders, rows };
}

exports.template = async (req, res) => {
  try {
    const meta = ENTITY[req.params.entity];
    if (!meta) {
      return res.status(404).json({ success: false, message: 'Unknown import entity' });
    }

    const wb = new ExcelJS.Workbook();
    const instructions = wb.addWorksheet('Instructions');

    instructions.addRow([meta.title]);
    instructions.addRow(['Required columns are marked Required. Use the Data sheet only. No formulas/macros are imported.']);
    instructions.addRow(['Duplicate mode: CREATE_ONLY skips existing natural keys; UPDATE_BY_KEY updates only after explicit preview/commit.']);
    instructions.addRow(['']);
    instructions.addRow(['Column Definitions:']);
    
    meta.columns.forEach(col => {
      instructions.addRow([`${col[0]}${col[2] ? ' (Required)' : ''}: ${col[1]}`]);
    });

    const ws = wb.addWorksheet(meta.sheet);
    ws.addRow(meta.columns.map(c => c[0]));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };
    
    // Add example row
    const exampleRow = meta.columns.map(c => {
      if (c[2]) return `Example ${c[1]}`;
      return '';
    });
    ws.addRow(exampleRow);

    // Auto-size columns
    ws.columns.forEach(column => {
      column.width = 20;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}-import-template.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Template generation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.preview = async (req, res) => {
  try {
    const entity = req.params.entity;
    const meta = ENTITY[entity];

    if (!meta) {
      return res.status(404).json({ success: false, message: 'Unknown import entity' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'An .xlsx or .csv file is required' });
    }

    const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
    if (!['xlsx', 'csv'].includes(ext)) {
      return res.status(400).json({ success: false, message: 'Only .xlsx or .csv files are supported' });
    }

    if (req.file.size > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'File size cannot exceed 10MB' });
    }

    const { headers, rows } = await rowsFromFile(req.file);
    const required = meta.columns.filter(c => c[2]).map(c => c[0]);
    const missing = required.filter(h => !headers.includes(h));

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required headers: ${missing.join(', ')}`
      });
    }

    const mode = req.body.mode === 'UPDATE_BY_KEY' ? 'UPDATE_BY_KEY' : 'CREATE_ONLY';
    const result = [];
    const summary = {
      validNew: 0,
      validUpdates: 0,
      duplicates: 0,
      invalid: 0,
      warnings: 0,
      created: 0,
      updated: 0,
      skipped: 0
    };

    for (const item of rows) {
      const data = normalize(entity, item.row, req.user.hospital_id, req.user._id);
      const errors = validate(entity, data);
      let action = 'create';
      let before = null;
      let target = null;

      if (!errors.length) {
        try {
          target = await existing(entity, data, req.user.hospital_id);

          if (target) {
            before = target.toObject ? target.toObject() : target;
            if (mode === 'UPDATE_BY_KEY') {
              action = 'update';
              summary.validUpdates++;
            } else {
              action = 'skip';
              summary.duplicates++;
            }
          } else {
            summary.validNew++;
          }
        } catch (error) {
          errors.push(`Database lookup error: ${error.message}`);
          action = 'invalid';
          summary.invalid++;
        }
      } else {
        action = 'invalid';
        summary.invalid++;
      }

      result.push({
        rowNumber: item.rowNumber,
        action,
        naturalKey: natural(entity, data),
        errors,
        warnings: [],
        data,
        targetId: target?._id,
        before
      });
    }

    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const key = req.headers['idempotency-key'] || crypto.randomUUID();

    const job = await BulkImportJob.findOneAndUpdate(
      { hospitalId: req.user.hospital_id, entity, idempotencyKey: key },
      {
        hospitalId: req.user.hospital_id,
        entity,
        status: 'preview_ready',
        templateVersion: '2026.07',
        originalFileName: req.file.originalname,
        fileHash: hash,
        uploadedBy: req.user._id,
        mode,
        idempotencyKey: key,
        summary,
        rows: result
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      jobId: job._id,
      summary: job.summary,
      rows: job.rows
    });
  } catch (error) {
    console.error('Preview error:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
};

exports.errors = async (req, res) => {
  try {
    const job = await BulkImportJob.findById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Import job not found' });
    }

    if (req.user.role !== 'mediqliq_super_admin' && String(job.hospitalId) !== String(req.user.hospital_id)) {
      return res.status(403).json({ success: false, message: 'Cross-hospital access denied' });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Import Result');

    ws.addRow(['Row', 'Action', 'Natural Key', 'Errors', 'Warnings']);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    job.rows.forEach(r => {
      ws.addRow([
        r.rowNumber,
        r.action,
        safeSheet(r.naturalKey || ''),
        (r.errors || []).map(safeSheet).join('; '),
        (r.warnings || []).map(safeSheet).join('; ')
      ]);
    });

    // Auto-size columns
    ws.columns.forEach(column => {
      column.width = 20;
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${job.entity}-import-errors.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Errors export error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.commit = async (req, res) => {
  try {
    const job = await BulkImportJob.findById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Import job not found' });
    }

    if (req.user.role !== 'mediqliq_super_admin' && String(job.hospitalId) !== String(req.user.hospital_id)) {
      return res.status(403).json({ success: false, message: 'Cross-hospital access denied' });
    }

    if (job.status === 'committed') {
      return res.json({ success: true, idempotent: true, job });
    }

    if (job.status !== 'preview_ready') {
      return res.status(409).json({
        success: false,
        message: `Job cannot be committed from status ${job.status}`
      });
    }

    // Check if there are any invalid rows
    const invalidRows = job.rows.filter(r => r.action === 'invalid');
    if (invalidRows.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot commit: ${invalidRows.length} rows have validation errors. Download the errors report to fix them.`
      });
    }

    job.status = 'committing';
    await job.save();

    const M = modelFor(job.entity);
    if (!M) {
      throw new Error(`Model not found for entity: ${job.entity}`);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const row of job.rows) {
      if (row.action === 'invalid' || row.action === 'skip') {
        skipped++;
        continue;
      }

      try {
        const current = await existing(job.entity, row.data, job.hospitalId);

        if (row.action === 'create' && !current) {
          const doc = await M.create(row.data);
          row.targetId = doc._id;
          row.after = doc.toObject ? doc.toObject() : doc;
          created++;
        } else if (row.action === 'update' && current) {
          const before = current.toObject ? current.toObject() : current;
          
          // Update with proper user tracking
          const updateData = { ...row.data };
          if (job.entity === 'employees') {
            updateData.updated_by = req.user._id;
          } else if (job.entity === 'charges' || job.entity === 'procedures') {
            updateData.updatedBy = req.user._id;
          }
          
          current.set(updateData);
          await current.save();
          row.targetId = current._id;
          row.before = before;
          row.after = current.toObject ? current.toObject() : current;
          updated++;
        } else {
          row.action = 'skip';
          skipped++;
        }
      } catch (error) {
        row.errors = row.errors || [];
        row.errors.push(`Commit error: ${error.message}`);
        row.action = 'invalid';
        skipped++;
        console.error(`Error committing row ${row.rowNumber}:`, error);
      }
    }

    job.summary.created = created;
    job.summary.updated = updated;
    job.summary.skipped = skipped;
    job.status = 'committed';
    job.committedBy = req.user._id;
    job.commitAt = new Date();
    await job.save();

    res.json({ 
      success: true, 
      job: {
        _id: job._id,
        status: job.status,
        summary: job.summary,
        entity: job.entity,
        committedBy: job.committedBy,
        commitAt: job.commitAt
      }
    });
  } catch (error) {
    console.error('Commit error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.history = async (req, res) => {
  try {
    const filter = req.user.role === 'mediqliq_super_admin'
      ? {}
      : { hospitalId: req.user.hospital_id };

    if (req.query.entity) {
      filter.entity = req.query.entity;
    }

    const jobs = await BulkImportJob.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit || 25), 100))
      .select('-rows -data');

    res.json({ success: true, jobs });
  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.rollback = async (req, res) => {
  try {
    const job = await BulkImportJob.findById(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Import job not found' });
    }

    if (req.user.role !== 'mediqliq_super_admin' && String(job.hospitalId) !== String(req.user.hospital_id)) {
      return res.status(403).json({ success: false, message: 'Cross-hospital access denied' });
    }

    if (job.status !== 'committed') {
      return res.status(409).json({
        success: false,
        message: 'Only committed import jobs can be rolled back'
      });
    }

    // Check if rollback is still allowed (within 24 hours)
    const hoursSinceCommit = (Date.now() - new Date(job.commitAt).getTime()) / (1000 * 60 * 60);
    if (hoursSinceCommit > 24) {
      return res.status(409).json({
        success: false,
        message: 'Rollback only allowed within 24 hours of commit'
      });
    }

    const M = modelFor(job.entity);
    if (!M) {
      throw new Error(`Model not found for entity: ${job.entity}`);
    }

    let rolledBack = 0;
    let errors = [];

    for (const row of [...job.rows].reverse()) {
      try {
        if (row.action === 'create' && row.targetId) {
          // Check if target has downstream use (simplified check)
          // In production, you'd want to check for foreign key references
          const doc = await M.findById(row.targetId);
          if (doc) {
            // Check for usage - this is a simplified check
            // You might want to add more sophisticated checks
            await M.findByIdAndDelete(row.targetId);
            rolledBack++;
          }
        } else if (row.action === 'update' && row.targetId && row.before) {
          // Remove _id and __v from before to avoid conflicts
          const beforeData = { ...row.before };
          delete beforeData._id;
          delete beforeData.__v;
          delete beforeData.createdAt;
          delete beforeData.updatedAt;
          
          await M.findByIdAndUpdate(row.targetId, beforeData, { runValidators: false });
          rolledBack++;
        }
      } catch (error) {
        errors.push(`Row ${row.rowNumber}: ${error.message}`);
        console.error(`Rollback error for row ${row.rowNumber}:`, error);
      }
    }

    job.status = 'rolled_back';
    job.rollbackAt = new Date();
    job.rolledBackBy = req.user._id;
    job.rollbackErrors = errors;
    job.rollbackSummary = {
      totalRolledBack: rolledBack,
      totalErrors: errors.length
    };
    await job.save();

    res.json({ 
      success: true, 
      jobId: job._id, 
      status: job.status,
      rolledBack,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Rollback error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};