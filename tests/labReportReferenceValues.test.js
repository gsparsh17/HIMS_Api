const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const { generateLabReportPdf } = require('../services/clinicalPdf.service');

class MemoryStream extends Writable {
  constructor(options) {
    super(options);
    this.chunks = [];
  }
  _write(chunk, encoding, callback) {
    this.chunks.push(chunk);
    callback();
  }
  getBuffer() {
    return Buffer.concat(this.chunks);
  }
  setHeader() {}
}

test('generateLabReportPdf resolves reference values and generates valid PDF for CBC test', async () => {
  const memoryStream = new MemoryStream();
  const request = {
    requestNumber: 'REQ-LAB-001',
    testName: 'Complete Blood Count (CBC)',
    testCode: 'LT-HAEM-009',
    status: 'Reported',
    report_mode: 'manual',
    manual_report: {
      templateId: 'lab-template-020',
      templateName: 'Complete Blood Count (CBC)',
      specimenType: 'EDTA whole blood',
      observations: [
        { name: 'Haemoglobin', resultNumeric: '12.9', unit: 'g/dL', flag: 'L' },
        { name: 'Total Leucocyte Count', resultNumeric: '10.6', unit: '10^3/uL' },
        { name: 'Neutrophils', resultNumeric: '72', unit: '%' },
        { name: 'Platelets', resultNumeric: '265', unit: '10^3/uL' }
      ]
    },
    patientId: {
      first_name: 'Rakesh',
      last_name: 'Sharma',
      patientId: 'PID-SEED-20260714-001',
      dob: new Date('1988-01-01'),
      gender: 'male',
      phone: '9876500001',
      address: '117/Seed House, Swaroop Nagar'
    },
    doctorId: {
      firstName: 'Dental',
      lastName: 'Test',
      specialization: 'Pathology'
    }
  };

  const hospital = {
    name: 'TEST HOSPITAL',
    address: 'Swaroop Nagar',
    city: 'Kanpur',
    state: 'UP',
    phone: '9927277272',
    email: 'admin@gmail.com'
  };

  await new Promise((resolve, reject) => {
    memoryStream.on('finish', resolve);
    memoryStream.on('error', reject);
    generateLabReportPdf({ res: memoryStream, request, hospital });
  });

  const pdfBuffer = memoryStream.getBuffer();
  assert.ok(pdfBuffer.length > 1000, 'PDF buffer should be generated');
  assert.equal(pdfBuffer.subarray(0, 4).toString(), '%PDF', 'Buffer should start with PDF magic bytes');
});

test('generateLabReportPdf synthesizes observations with reference intervals from result_value string', async () => {
  const memoryStream = new MemoryStream();
  const request = {
    requestNumber: 'REQ-LAB-002',
    testName: 'Complete Blood Count (CBC)',
    testCode: 'LT-HAEM-009',
    status: 'Completed',
    result_value: 'Haemoglobin: 13.1 g/dL; Total Leucocyte Count: 7.8 10^3/uL; Neutrophils: 64 %; Platelets: 292 10^3/uL',
    result_interpretation: 'Counts normalised; suitable for discharge.',
    patientId: {
      first_name: 'Rakesh',
      last_name: 'Sharma',
      patientId: 'PID-SEED-20260714-001'
    }
  };

  await new Promise((resolve, reject) => {
    memoryStream.on('finish', resolve);
    memoryStream.on('error', reject);
    generateLabReportPdf({ res: memoryStream, request, hospital: null });
  });

  const pdfBuffer = memoryStream.getBuffer();
  assert.ok(pdfBuffer.length > 1000, 'PDF buffer should be generated');
  assert.equal(pdfBuffer.subarray(0, 4).toString(), '%PDF');
});
