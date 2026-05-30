/**
 * One-time migration helper for the pharmacy unit model.
 *
 * Why it exists:
 * Old inventory used MedicineBatch.quantity without a strict definition.
 * The pharmacy module uses quantity_base_units as the source of truth.
 * This script intentionally treats old quantity as BASE UNITS, not strips,
 * to avoid accidentally multiplying inventory. After migration, update each
 * medicine's units_per_pack and each batch's selling_price_per_pack if needed.
 *
 * Usage:
 *   node scripts/migratePharmacyUnits.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');

async function run() {
  await connectDB();

  const medicines = await Medicine.find({});
  let medicineUpdates = 0;
  for (const medicine of medicines) {
    let changed = false;
    if (!medicine.base_unit) { medicine.base_unit = 'tablet'; changed = true; }
    if (!medicine.pack_unit) { medicine.pack_unit = 'strip'; changed = true; }
    if (!medicine.units_per_pack || medicine.units_per_pack < 1) { medicine.units_per_pack = 1; changed = true; }
    if (medicine.allow_loose_sale == null) { medicine.allow_loose_sale = true; changed = true; }
    if (medicine.min_stock_level_base_units == null) { medicine.min_stock_level_base_units = medicine.min_stock_level || 10; changed = true; }
    if (changed) { await medicine.save(); medicineUpdates += 1; }
  }

  const batches = await MedicineBatch.find({}).populate('medicine_id');
  let batchUpdates = 0;
  for (const batch of batches) {
    const medicine = batch.medicine_id;
    const unitsPerPack = medicine?.units_per_pack || batch.units_per_pack || 1;
    let changed = false;

    if (!batch.units_per_pack || batch.units_per_pack < 1) { batch.units_per_pack = unitsPerPack; changed = true; }
    if (batch.quantity_base_units == null) { batch.quantity_base_units = batch.quantity || 0; changed = true; }
    if (!batch.opening_quantity_base_units) { batch.opening_quantity_base_units = batch.quantity_base_units || 0; changed = true; }
    if (batch.purchase_price_per_pack == null) { batch.purchase_price_per_pack = batch.purchase_price || 0; changed = true; }
    if (batch.selling_price_per_pack == null) { batch.selling_price_per_pack = batch.selling_price || 0; changed = true; }
    if (batch.mrp_per_pack == null) { batch.mrp_per_pack = batch.selling_price_per_pack || 0; changed = true; }
    if (batch.purchase_price_per_base_unit == null) { batch.purchase_price_per_base_unit = Number(((batch.purchase_price_per_pack || 0) / batch.units_per_pack).toFixed(4)); changed = true; }
    if (batch.selling_price_per_base_unit == null) { batch.selling_price_per_base_unit = Number(((batch.selling_price_per_pack || 0) / batch.units_per_pack).toFixed(4)); changed = true; }
    if (batch.quantity !== batch.quantity_base_units) { batch.quantity = batch.quantity_base_units; changed = true; }

    if (changed) { await batch.save(); batchUpdates += 1; }
  }

  console.log(`Migration complete. Medicines updated: ${medicineUpdates}. Batches updated: ${batchUpdates}.`);
  await mongoose.connection.close();
}

run().catch(async (error) => {
  console.error(error);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
