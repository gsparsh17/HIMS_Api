'use strict';

const {
  previewLedgerSettlement,
  postLedgerSettlement,
  getSettlementById,
  listSettlements,
  reverseLedgerSettlement,
} = require('../services/pharmacyLedgerSettlement.service');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requestContext(req) {
  return {
    hospitalId: req.user?.hospital_id || req.user?.hospitalId || req.body?.hospitalId || req.query?.hospitalId,
    pharmacyId: req.body?.pharmacyId || req.query?.pharmacyId,
    createdBy: req.user?._id || req.user?.id || req.body?.createdBy,
  };
}

exports.preview = asyncHandler(async (req, res) => {
  const preview = await previewLedgerSettlement(req.body, requestContext(req));
  res.json({ success: true, preview });
});

exports.create = asyncHandler(async (req, res) => {
  const result = await postLedgerSettlement(req.body, requestContext(req));
  res.status(result.replayed ? 200 : 201).json({
    success: true,
    replayed: result.replayed,
    message: result.replayed ? 'Existing settlement returned for this idempotency key.' : 'Pharmacy ledger settlement posted successfully.',
    settlement: result.settlement,
  });
});

exports.getOne = asyncHandler(async (req, res) => {
  const settlement = await getSettlementById(req.params.settlementId);
  if (!settlement) return res.status(404).json({ success: false, error: 'Settlement not found.' });
  res.json({ success: true, settlement });
});

exports.list = asyncHandler(async (req, res) => {
  const settlements = await listSettlements(req.query);
  res.json({ success: true, settlements });
});

exports.reverse = asyncHandler(async (req, res) => {
  const settlement = await reverseLedgerSettlement(req.params.settlementId, req.body, requestContext(req));
  res.json({ success: true, message: 'Pharmacy ledger settlement reversed.', settlement });
});
