const crypto = require('crypto');

/**
 * Patient-file packets are intentionally rendered by the isolated browser
 * print surface in Hospital-Admin. That path reuses the exact HIMS clinical,
 * OT, laboratory, radiology, invoice and receipt templates.
 *
 * A previous patch re-enabled a generic PDFKit merger here. Besides degrading
 * document fidelity, that implementation accepted remote/local file fallbacks
 * and could apply source-document signature coordinates to shifted packet
 * pages. Keep this service as an explicit tombstone so future callers cannot
 * silently reintroduce that rendering/security regression.
 */
async function renderPatientFilePdf() {
  const error = new Error(
    'Server-side patient-file PDF generation is retired. Use the Hospital-Admin patient-file builder and its isolated A4 print surface.'
  );
  error.statusCode = 410;
  throw error;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { renderPatientFilePdf, sha256 };
