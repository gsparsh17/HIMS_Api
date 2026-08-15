'use strict';

const Payer = require('../models/Payer');
const RateCard = require('../models/RateCard');
const RateCardItem = require('../models/RateCardItem');

const HOSPITAL_BASIC_TARIFF_VERSION = 'HOSPITAL-BASIC-2026-08-15';
const DAILY_TARIFF_CODES = Object.freeze({
  bed: 'HBT-001',
  nursing: 'HBT-002',
  rmo: 'HBT-003'
});

function wardEntitlementFrom(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!normalized) return 'general';
  if (normalized.includes('icu') || normalized.includes('critical')) return 'icu';
  if (normalized.includes('deluxe')) return 'deluxe';
  if (normalized.includes('semi')) return 'semi_private';
  if (normalized.includes('private')) return 'private';
  if (normalized.includes('day care') || normalized.includes('daycare')) return 'day_care';
  return 'general';
}

function exactWardAmount(item, wardEntitlement) {
  const rates = item?.rates?.exactWard || {};
  const key = wardEntitlementFrom(wardEntitlement);
  const field = {
    general: 'general',
    semi_private: 'semiPrivate',
    private: 'private',
    deluxe: 'deluxe',
    icu: 'icu',
    day_care: 'dayCare',
    not_applicable: 'notApplicable'
  }[key] || 'general';
  const direct = Number(rates[field]);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const fallback = Number(rates.general ?? item?.rates?.flatAmount);
  return Number.isFinite(fallback) ? fallback : null;
}

async function findSelfPayer(hospitalId) {
  return Payer.findOne({ hospitalId, isActive: { $ne: false }, $or: [{ code: 'SELF' }, { type: 'self' }] }).lean();
}

async function findHospitalBasicRateCard(hospitalId, serviceDate = new Date()) {
  const payer = await findSelfPayer(hospitalId);
  if (!payer) return null;
  const when = new Date(serviceDate);
  const rateCard = await RateCard.findOne({
    hospitalId,
    payerId: payer._id,
    version: HOSPITAL_BASIC_TARIFF_VERSION,
    status: 'active',
    effectiveFrom: { $lte: when },
    $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: null }, { effectiveTo: { $gte: when } }]
  }).sort({ effectiveFrom: -1, createdAt: -1 }).lean();
  return rateCard ? { payer, rateCard } : null;
}

async function resolveHospitalTariffRate({ hospitalId, externalCode, wardEntitlement, serviceDate = new Date() }) {
  const context = await findHospitalBasicRateCard(hospitalId, serviceDate);
  if (!context) return null;
  const item = await RateCardItem.findOne({
    hospitalId,
    payerId: context.payer._id,
    rateCardId: context.rateCard._id,
    externalCode: String(externalCode || '').trim().toUpperCase(),
    active: { $ne: false }
  }).lean();
  if (!item) return null;
  const amount = item.pricingMode === 'exact_ward'
    ? exactWardAmount(item, wardEntitlement)
    : Number(item?.rates?.flatAmount ?? item?.rates?.tierI?.nabh);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { amount, item, payer: context.payer, rateCard: context.rateCard, wardEntitlement: wardEntitlementFrom(wardEntitlement) };
}

module.exports = {
  HOSPITAL_BASIC_TARIFF_VERSION,
  DAILY_TARIFF_CODES,
  wardEntitlementFrom,
  exactWardAmount,
  findHospitalBasicRateCard,
  resolveHospitalTariffRate
};
