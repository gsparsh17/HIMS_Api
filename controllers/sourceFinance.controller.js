const { postSourceCharge, getSourceFinancialStatus, previewSourceFinancialPolicy, reverseSourceFinancials } = require('../services/chargePosting.service');
const { assertUserHospital } = require('../utils/hospitalScope');

function normalizeModule(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['lab', 'labrequest', 'laboratory'].includes(raw)) return 'LabRequest';
  if (['radiology', 'radiologyrequest', 'imaging'].includes(raw)) return 'RadiologyRequest';
  if (['procedure', 'procedurerequest'].includes(raw)) return 'ProcedureRequest';
  if (['ot', 'otrequest', 'surgery', 'operation_theatre'].includes(raw)) return 'OTRequest';
  return null;
}

exports.postCharge = async (req, res) => {
  try {
    assertUserHospital(req.user);
    const sourceModule = normalizeModule(req.params.sourceModule);
    if (!sourceModule) return res.status(400).json({ success: false, error: 'Unsupported clinical source' });
    const result = await postSourceCharge({
      sourceModule,
      sourceId: req.params.sourceId,
      billingIntent: req.body?.billingIntent,
      selectedMode: req.body?.selectedMode,
      requestedDeposit: req.body?.requestedDeposit,
      adjustments: {
        discountType: req.body?.discountType,
        discountRate: req.body?.discountRate,
        discountAmount: req.body?.discountAmount,
        discountValue: req.body?.discountValue,
        discountReason: req.body?.discountReason,
        taxMode: req.body?.taxMode,
        taxRate: req.body?.taxRate,
        taxReason: req.body?.taxReason,
      },
      overrideReason: req.body?.overrideReason,
      idempotencyKey: req.body?.idempotencyKey || req.get('Idempotency-Key') || `${sourceModule}:${req.params.sourceId}:charge`,
      user: req.user,
    });
    const policy = result.financialPolicy || result.bill?.items?.[0]?.source_snapshot?.financialPolicy || null;
    return res.status(result.alreadyExists ? 200 : 201).json({
      success: true,
      reused: Boolean(result.alreadyExists),
      sourceModule,
      sourceId: req.params.sourceId,
      charge: result.charge || null,
      bill: result.bill || null,
      invoice: result.invoice || null,
      financialPolicy: policy,
      clearanceState: result.charge?.clearanceState || result.financialPolicy?.clearanceState || result.financialPolicy?.policySnapshot?.clearanceState || null,
    });
  } catch (error) {
    console.error('Source finance error:', error);
    return res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code, details: error.details });
  }
};

exports.getStatus = async (req, res) => {
  try {
    assertUserHospital(req.user);
    const sourceModule = normalizeModule(req.params.sourceModule);
    if (!sourceModule) return res.status(400).json({ success: false, error: 'Unsupported clinical source' });
    const result = await getSourceFinancialStatus({ sourceModule, sourceId: req.params.sourceId, user: req.user });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('Source finance status error:', error);
    return res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
  }
};

exports.previewPolicy = async (req, res) => {
  try {
    assertUserHospital(req.user);
    const sourceModule = normalizeModule(req.params.sourceModule);
    if (!sourceModule) return res.status(400).json({ success: false, error: 'Unsupported clinical source' });
    const result = await previewSourceFinancialPolicy({
      sourceModule, sourceId: req.params.sourceId, selectedMode: req.body?.selectedMode, requestedDeposit: req.body?.requestedDeposit,
      adjustments: { discountType: req.body?.discountType, discountRate: req.body?.discountRate, discountAmount: req.body?.discountAmount, discountValue: req.body?.discountValue, discountReason: req.body?.discountReason, taxMode: req.body?.taxMode, taxRate: req.body?.taxRate, taxReason: req.body?.taxReason },
      overrideReason: req.body?.overrideReason, user: req.user
    });
    return res.json({ success: true, sourceModule, sourceId: req.params.sourceId, quote: result.quote, financialPolicy: result.financialPolicy });
  } catch (error) {
    console.error('Source finance policy preview error:', error);
    return res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code, details: error.details });
  }
};


exports.reverseSource = async (req, res) => {
  try {
    assertUserHospital(req.user);
    const sourceModule = normalizeModule(req.params.sourceModule);
    if (!sourceModule) return res.status(400).json({ success: false, error: 'Unsupported clinical source' });
    const result = await reverseSourceFinancials({
      sourceModule,
      sourceId: req.params.sourceId,
      reason: req.body?.reason,
      paymentMethod: req.body?.paymentMethod,
      reference: req.body?.reference,
      user: req.user
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('Source finance reversal error:', error);
    return res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code, details: error.details });
  }
};
