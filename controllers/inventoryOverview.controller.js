'use strict';

const mongoose = require('mongoose');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const StoreItem = require('../models/StoreItem');
const InventoryLot = require('../models/InventoryLot');
const { requestHospitalId } = require('../utils/hospitalScope');

const LEGACY_EQUIPMENT_CATEGORY_REGEX = /(equipment|accessor|instrument|device|hardware|furniture|monitor|stethoscope)/i;

function hospitalObjectId(req) {
  const value = requestHospitalId(req);
  if (value instanceof mongoose.Types.ObjectId) return value;
  return mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : value;
}

function safeRegex(value) {
  return new RegExp(String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function normaliseDomain(value) {
  const domain = String(value || 'all').toLowerCase();
  return ['all', 'pharmacy', 'store', 'assets'].includes(domain) ? domain : 'all';
}

exports.getInventoryOverview = async (req, res) => {
  try {
    const hospitalId = hospitalObjectId(req);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const domain = normaliseDomain(req.query.domain);
    const search = String(req.query.search || '').trim();
    const stock = String(req.query.stock || '').toLowerCase();
    const skip = (page - 1) * limit;
    const now = new Date();
    const expiryCutoff = new Date(now);
    expiryCutoff.setDate(expiryCutoff.getDate() + 90);

    const pharmacyMatch = {
      hospitalId,
      is_active: { $ne: false },
      $or: [
        { inventory_domain: 'pharmaceutical' },
        { inventory_domain: { $exists: false }, category: { $not: LEGACY_EQUIPMENT_CATEGORY_REGEX } },
        { inventory_domain: null, category: { $not: LEGACY_EQUIPMENT_CATEGORY_REGEX } }
      ]
    };

    const pharmacyPipeline = [
      { $match: pharmacyMatch },
      {
        $lookup: {
          from: MedicineBatch.collection.name,
          let: { medicineId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$medicine_id', '$$medicineId'] },
              { $eq: ['$is_active', true] },
              { $gt: [{ $ifNull: ['$quantity', '$quantity_base_units'] }, 0] }
            ] } } },
            { $project: { quantity: 1, quantity_base_units: 1, purchase_price: 1, expiry_date: 1 } }
          ],
          as: '_stockRows'
        }
      },
      {
        $set: {
          _stock: { $sum: { $map: { input: '$_stockRows', as: 'b', in: { $ifNull: ['$$b.quantity', '$$b.quantity_base_units'] } } } },
          _value: { $sum: { $map: { input: '$_stockRows', as: 'b', in: { $multiply: [{ $ifNull: ['$$b.purchase_price', 0] }, { $ifNull: ['$$b.quantity', '$$b.quantity_base_units'] }] } } } },
          _minimum: { $ifNull: ['$min_stock_level_base_units', { $ifNull: ['$min_stock_level', 0] }] },
          _earliestExpiry: { $min: '$_stockRows.expiry_date' }
        }
      },
      {
        $project: {
          _id: 1,
          domain: { $literal: 'pharmacy' },
          sourceModel: { $literal: 'Medicine' },
          sourceId: '$_id',
          code: { $ifNull: ['$nlem_code', ''] },
          name: 1,
          category: 1,
          itemType: { $ifNull: ['$pharmaceutical_type', 'medicine'] },
          accountingTreatment: { $ifNull: ['$accounting_treatment', 'inventory'] },
          unit: { $ifNull: ['$base_unit', 'unit'] },
          quantity: '$_stock',
          reserved: { $literal: 0 },
          available: '$_stock',
          minimumStock: '$_minimum',
          unitCost: {
            $cond: [
              { $gt: ['$_stock', 0] },
              { $divide: ['$_value', '$_stock'] },
              0
            ]
          },
          totalValue: '$_value',
          expiryDate: '$_earliestExpiry',
          location: {
            $trim: {
              input: {
                $concat: [
                  { $ifNull: ['$location.shelf', ''] },
                  { $cond: [{ $and: [{ $ne: [{ $ifNull: ['$location.shelf', ''] }, ''] }, { $ne: [{ $ifNull: ['$location.rack', ''] }, ''] }] }, ' / ', ''] },
                  { $ifNull: ['$location.rack', ''] }
                ]
              }
            }
          },
          status: {
            $switch: {
              branches: [
                { case: { $lte: ['$_stock', 0] }, then: 'Out of Stock' },
                { case: { $and: [{ $gt: ['$_minimum', 0] }, { $lte: ['$_stock', '$_minimum'] }] }, then: 'Low Stock' }
              ],
              default: 'In Stock'
            }
          }
        }
      }
    ];

    const storePipeline = [
      { $match: { hospital_id: hospitalId, is_active: { $ne: false } } },
      {
        $lookup: {
          from: InventoryLot.collection.name,
          let: { itemId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$hospitalId', hospitalId] },
              { $eq: ['$itemId', '$$itemId'] },
              { $not: [{ $in: ['$qualityStatus', ['Rejected', 'Recalled']] }] }
            ] } } },
            { $project: { totalOnHand: 1, totalReserved: 1, totalAvailable: 1, unitCost: 1, expiryDate: 1 } }
          ],
          as: '_lots'
        }
      },
      {
        $set: {
          _hasLots: { $gt: [{ $size: '$_lots' }, 0] },
          _lotOnHand: { $sum: '$_lots.totalOnHand' },
          _lotReserved: { $sum: '$_lots.totalReserved' },
          _lotAvailable: { $sum: '$_lots.totalAvailable' },
          _lotValue: { $sum: { $map: { input: '$_lots', as: 'lot', in: { $multiply: [{ $ifNull: ['$$lot.totalOnHand', 0] }, { $ifNull: ['$$lot.unitCost', 0] }] } } } },
          _earliestExpiry: { $min: '$_lots.expiryDate' }
        }
      },
      {
        $set: {
          _stock: { $cond: ['$_hasLots', '$_lotOnHand', { $ifNull: ['$current_stock', 0] }] },
          _reserved: { $cond: ['$_hasLots', '$_lotReserved', 0] },
          _available: { $cond: ['$_hasLots', '$_lotAvailable', { $ifNull: ['$current_stock', 0] }] },
          _value: {
            $cond: [
              '$_hasLots',
              '$_lotValue',
              { $multiply: [{ $ifNull: ['$current_stock', 0] }, { $ifNull: ['$average_cost', { $ifNull: ['$last_purchase_price', 0] }] }] }
            ]
          },
          _minimum: { $ifNull: ['$reorder_level', { $ifNull: ['$minimum_stock', 0] }] }
        }
      },
      {
        $project: {
          _id: 1,
          domain: { $cond: [{ $eq: ['$item_type', 'asset'] }, 'assets', 'store'] },
          sourceModel: { $literal: 'StoreItem' },
          sourceId: '$_id',
          code: '$item_code',
          name: 1,
          category: '$item_type',
          itemType: '$item_type',
          accountingTreatment: { $cond: [{ $eq: ['$item_type', 'asset'] }, 'capex_candidate', 'inventory_or_expense'] },
          unit: 1,
          quantity: '$_stock',
          reserved: '$_reserved',
          available: '$_available',
          minimumStock: '$_minimum',
          unitCost: { $cond: [{ $gt: ['$_stock', 0] }, { $divide: ['$_value', '$_stock'] }, { $ifNull: ['$average_cost', 0] }] },
          totalValue: '$_value',
          expiryDate: { $ifNull: ['$_earliestExpiry', '$expiry_date'] },
          location: { $ifNull: ['$location', { $ifNull: ['$storage_location', ''] }] },
          status: {
            $switch: {
              branches: [
                { case: { $eq: ['$item_type', 'asset'] }, then: { $ifNull: ['$operational_status', 'Available'] } },
                { case: { $lte: ['$_stock', 0] }, then: 'Out of Stock' },
                { case: { $and: [{ $gt: ['$_minimum', 0] }, { $lte: ['$_available', '$_minimum'] }] }, then: 'Low Stock' }
              ],
              default: 'In Stock'
            }
          }
        }
      }
    ];

    let pipeline;
    let aggregateModel = Medicine;
    if (domain === 'pharmacy') {
      pipeline = [...pharmacyPipeline];
    } else if (domain === 'store') {
      aggregateModel = StoreItem;
      pipeline = [...storePipeline, { $match: { domain: 'store' } }];
    } else if (domain === 'assets') {
      aggregateModel = StoreItem;
      pipeline = [...storePipeline, { $match: { domain: 'assets' } }];
    } else {
      pipeline = [
        ...pharmacyPipeline,
        { $unionWith: { coll: StoreItem.collection.name, pipeline: storePipeline } }
      ];
    }

    if (search) {
      const regex = safeRegex(search);
      pipeline.push({ $match: { $or: [{ name: regex }, { code: regex }, { category: regex }, { itemType: regex }, { location: regex }] } });
    }
    if (stock === 'low') pipeline.push({ $match: { status: 'Low Stock' } });
    if (stock === 'out') pipeline.push({ $match: { status: 'Out of Stock' } });
    if (stock === 'in') pipeline.push({ $match: { status: 'In Stock' } });

    pipeline.push({
      $facet: {
        rows: [
          { $sort: { name: 1, domain: 1 } },
          { $skip: skip },
          { $limit: limit }
        ],
        totals: [
          {
            $group: {
              _id: null,
              totalItems: { $sum: 1 },
              totalValue: { $sum: { $ifNull: ['$totalValue', 0] } },
              lowStock: { $sum: { $cond: [{ $eq: ['$status', 'Low Stock'] }, 1, 0] } },
              outOfStock: { $sum: { $cond: [{ $eq: ['$status', 'Out of Stock'] }, 1, 0] } },
              pharmacyItems: { $sum: { $cond: [{ $eq: ['$domain', 'pharmacy'] }, 1, 0] } },
              storeItems: { $sum: { $cond: [{ $eq: ['$domain', 'store'] }, 1, 0] } },
              assetItems: { $sum: { $cond: [{ $eq: ['$domain', 'assets'] }, 1, 0] } },
              expiringWithin90Days: { $sum: { $cond: [{ $and: [{ $gte: ['$expiryDate', now] }, { $lte: ['$expiryDate', expiryCutoff] }] }, 1, 0] } }
            }
          },
          { $project: { _id: 0 } }
        ]
      }
    });

    const [result] = await aggregateModel.aggregate(pipeline).allowDiskUse(true);
    const summary = result?.totals?.[0] || {
      totalItems: 0,
      totalValue: 0,
      lowStock: 0,
      outOfStock: 0,
      pharmacyItems: 0,
      storeItems: 0,
      assetItems: 0,
      expiringWithin90Days: 0
    };

    return res.json({
      success: true,
      data: result?.rows || [],
      summary,
      pagination: {
        page,
        limit,
        total: summary.totalItems || 0,
        totalPages: Math.max(1, Math.ceil((summary.totalItems || 0) / limit))
      },
      sourceOfTruth: {
        pharmacy: 'Medicine + MedicineBatch',
        store: 'StoreItem + InventoryLot',
        assets: 'StoreItem(item_type=asset) + InventoryLot'
      }
    });
  } catch (error) {
    console.error('Inventory overview failed:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to load inventory overview' });
  }
};
