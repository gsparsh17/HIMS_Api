// scripts/fix-all-medicine-data.js
// ONE SCRIPT TO FIX EVERYTHING - Run with: node scripts/fix-all-medicine-data.js

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');

// Configuration
const DEFAULT_EXTENSION_DAYS = 365; // Extend expiry by 1 year
const DEFAULT_QUANTITY = 100; // Default quantity to set
const LOW_STOCK_THRESHOLD = 10;

async function fixAllData() {
  let backupMedicines = [];
  let backupBatches = [];
  
  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/HMS';
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ MongoDB connected successfully\n');

    // ==================== CREATE BACKUP ====================
    console.log('💾 Creating backups...');
    const timestamp = Date.now();
    const backupDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    
    backupMedicines = await Medicine.find({}).lean();
    const medicineBackupFile = path.join(backupDir, `medicines_backup_${timestamp}.json`);
    fs.writeFileSync(medicineBackupFile, JSON.stringify(backupMedicines, null, 2));
    console.log(`  ✓ Medicines backup: ${medicineBackupFile} (${backupMedicines.length} records)`);
    
    backupBatches = await MedicineBatch.find({}).lean();
    const batchBackupFile = path.join(backupDir, `batches_backup_${timestamp}.json`);
    fs.writeFileSync(batchBackupFile, JSON.stringify(backupBatches, null, 2));
    console.log(`  ✓ Batches backup: ${batchBackupFile} (${backupBatches.length} records)`);

    // ==================== 1. FIX MEDICINES ====================
    console.log('\n📋 1. FIXING MEDICINES...');
    const medicines = await Medicine.find({});
    let medicinesUpdated = 0;
    
    for (const medicine of medicines) {
      const updates = {};
      
      // Set default HSN code if missing
      if (!medicine.hsn_code) {
        updates.hsn_code = '30049099';
      }
      
      // Set default GST rate if missing
      if (medicine.gst_rate === undefined || medicine.gst_rate === null) {
        // Determine GST based on category
        const category = (medicine.category || '').toLowerCase();
        let gstRate = 5; // default
        if (['injection', 'syrup', 'ointment', 'cream', 'gel'].includes(category)) {
          gstRate = 12;
        }
        updates.gst_rate = gstRate;
        
        // Add to history
        await Medicine.updateOne(
          { _id: medicine._id },
          {
            $set: { gst_rate: gstRate, updated_at: new Date() },
            $push: {
              gst_history: {
                hsn_code: medicine.hsn_code || '30049099',
                gst_rate: gstRate,
                effective_from: new Date(),
                reason: 'Auto-fix - Missing GST rate',
                changed_by: null
              }
            }
          }
        );
        medicinesUpdated++;
        console.log(`  ✓ ${medicine.name}: Set GST to ${gstRate}%`);
      } else if (Object.keys(updates).length > 0) {
        await Medicine.updateOne(
          { _id: medicine._id },
          { $set: { ...updates, updated_at: new Date() } }
        );
        medicinesUpdated++;
      }
    }
    console.log(`  ✅ Medicines fixed: ${medicinesUpdated}`);

    // ==================== 2. FIX BATCHES - CLEANUP ====================
    console.log('\n📦 2. CLEANING UP BATCHES...');
    
    // Remove top-level gst_rate field
    const removeResult = await MedicineBatch.updateMany(
      { gst_rate: { $exists: true } },
      { $unset: { gst_rate: "" } }
    );
    console.log(`  ✓ Removed top-level gst_rate from ${removeResult.modifiedCount} batches`);

    // ==================== 3. FIX EXPIRY DATES ====================
    console.log('\n📅 3. FIXING EXPIRY DATES...');
    const today = new Date();
    const batches = await MedicineBatch.find({});
    let expiredFixed = 0;
    let futureDatesSet = 0;
    
    for (const batch of batches) {
      const expiryDate = new Date(batch.expiry_date);
      let needsUpdate = false;
      let newExpiryDate = null;
      
      // Check if expired
      if (expiryDate < today) {
        // Extend expiry by DEFAULT_EXTENSION_DAYS days
        newExpiryDate = new Date(today);
        newExpiryDate.setDate(today.getDate() + DEFAULT_EXTENSION_DAYS);
        needsUpdate = true;
        expiredFixed++;
        console.log(`  ✓ Batch ${batch.batch_number}: Expiry ${expiryDate.toLocaleDateString()} → ${newExpiryDate.toLocaleDateString()} (+${DEFAULT_EXTENSION_DAYS} days)`);
      }
      
      // Set default expiry if missing or invalid
      if (!batch.expiry_date || isNaN(expiryDate.getTime())) {
        newExpiryDate = new Date(today);
        newExpiryDate.setDate(today.getDate() + DEFAULT_EXTENSION_DAYS);
        needsUpdate = true;
        futureDatesSet++;
        console.log(`  ✓ Batch ${batch.batch_number}: Set expiry to ${newExpiryDate.toLocaleDateString()}`);
      }
      
      if (needsUpdate && newExpiryDate) {
        await MedicineBatch.updateOne(
          { _id: batch._id },
          { $set: { expiry_date: newExpiryDate } }
        );
      }
    }
    console.log(`  ✅ Expired batches fixed: ${expiredFixed}, New expiry set: ${futureDatesSet}`);

    // ==================== 4. FIX QUANTITIES ====================
    console.log('\n📊 4. FIXING QUANTITIES...');
    let quantitiesFixed = 0;
    
    for (const batch of batches) {
      const updates = {};
      
      // Ensure quantity is set (default to DEFAULT_QUANTITY if not set or zero for expired)
      const isExpired = new Date(batch.expiry_date) < today;
      let newQuantity = batch.quantity;
      
      if (!batch.quantity || batch.quantity === 0) {
        newQuantity = isExpired ? 0 : DEFAULT_QUANTITY;
        updates.quantity = newQuantity;
        updates.quantity_base_units = newQuantity;
        quantitiesFixed++;
        console.log(`  ✓ Batch ${batch.batch_number}: Quantity ${batch.quantity || 0} → ${newQuantity} ${isExpired ? '(expired, set to 0)' : '(default)'}`);
      }
      
      // Ensure quantity and quantity_base_units match
      if (batch.quantity !== batch.quantity_base_units) {
        updates.quantity_base_units = batch.quantity;
        quantitiesFixed++;
        console.log(`  ✓ Batch ${batch.batch_number}: Synced quantity_base_units to ${batch.quantity}`);
      }
      
      if (Object.keys(updates).length > 0) {
        await MedicineBatch.updateOne({ _id: batch._id }, { $set: updates });
      }
    }
    console.log(`  ✅ Quantities fixed: ${quantitiesFixed}`);

    // ==================== 5. FIX PRICES ====================
    console.log('\n💰 5. FIXING PRICES...');
    let pricesFixed = 0;
    
    for (const batch of batches) {
      const updates = {};
      
      // Calculate correct per-unit prices
      const unitsPerPack = batch.units_per_pack || 1;
      const correctSellingPerUnit = batch.selling_price_per_pack / unitsPerPack;
      const correctPurchasePerUnit = batch.purchase_price_per_pack / unitsPerPack;
      
      if (Math.abs(batch.selling_price_per_base_unit - correctSellingPerUnit) > 0.01) {
        updates.selling_price_per_base_unit = Number(correctSellingPerUnit.toFixed(4));
        pricesFixed++;
      }
      
      if (Math.abs(batch.purchase_price_per_base_unit - correctPurchasePerUnit) > 0.01) {
        updates.purchase_price_per_base_unit = Number(correctPurchasePerUnit.toFixed(4));
        pricesFixed++;
      }
      
      // Ensure selling_price is set
      if (!batch.selling_price && batch.selling_price_per_pack) {
        updates.selling_price = batch.selling_price_per_pack;
        pricesFixed++;
      }
      
      // Ensure purchase_price is set
      if (!batch.purchase_price && batch.purchase_price_per_pack) {
        updates.purchase_price = batch.purchase_price_per_pack;
        pricesFixed++;
      }
      
      if (Object.keys(updates).length > 0) {
        await MedicineBatch.updateOne({ _id: batch._id }, { $set: updates });
        if (updates.selling_price_per_base_unit || updates.purchase_price_per_base_unit) {
          console.log(`  ✓ Batch ${batch.batch_number}: Price calculations corrected`);
        }
      }
    }
    console.log(`  ✅ Prices fixed: ${pricesFixed}`);

    // ==================== 6. UPDATE TAX SNAPSHOTS ====================
    console.log('\n🔖 6. UPDATING TAX SNAPSHOTS...');
    let taxSnapshotsUpdated = 0;
    
    for (const batch of batches) {
      const medicine = await Medicine.findById(batch.medicine_id);
      if (!medicine) {
        console.log(`  ⚠️ Warning: Medicine not found for batch ${batch.batch_number}`);
        continue;
      }
      
      // Update tax snapshot if missing or outdated
      const needsUpdate = !batch.tax_snapshot ||
        batch.tax_snapshot.hsn_code !== medicine.hsn_code ||
        batch.tax_snapshot.gst_rate !== medicine.gst_rate;
      
      if (needsUpdate) {
        await MedicineBatch.updateOne(
          { _id: batch._id },
          {
            $set: {
              tax_snapshot: {
                hsn_code: medicine.hsn_code,
                gst_rate: medicine.gst_rate,
                captured_at: new Date(),
                medicine_version: medicine.__v || 0
              }
            }
          }
        );
        taxSnapshotsUpdated++;
        console.log(`  ✓ Batch ${batch.batch_number}: Tax snapshot updated (GST: ${medicine.gst_rate}%)`);
      }
    }
    console.log(`  ✅ Tax snapshots updated: ${taxSnapshotsUpdated}`);

    // ==================== 7. MARK EXPIRED BATCHES AS INACTIVE ====================
    console.log('\n🚫 7. MARKING EXPIRED BATCHES...');
    const now = new Date();
    const expiredResult = await MedicineBatch.updateMany(
      { 
        expiry_date: { $lt: now },
        is_active: true
      },
      { $set: { is_active: false } }
    );
    console.log(`  ✅ Marked ${expiredResult.modifiedCount} expired batches as inactive`);

    // ==================== 8. FIX UNITS PER PACK ====================
    console.log('\n📦 8. FIXING UNITS PER PACK...');
    let unitsFixed = 0;
    
    for (const batch of batches) {
      const medicine = await Medicine.findById(batch.medicine_id);
      if (medicine && (!batch.units_per_pack || batch.units_per_pack < 1)) {
        await MedicineBatch.updateOne(
          { _id: batch._id },
          { $set: { units_per_pack: medicine.units_per_pack || 1 } }
        );
        unitsFixed++;
        console.log(`  ✓ Batch ${batch.batch_number}: Set units_per_pack to ${medicine.units_per_pack || 1}`);
      }
    }
    console.log(`  ✅ Units per pack fixed: ${unitsFixed}`);

    // ==================== 9. GENERATE FINAL REPORT ====================
    console.log('\n📊 9. GENERATING FINAL REPORT...');
    
    const finalBatches = await MedicineBatch.find({}).populate('medicine_id');
    const finalMedicines = await Medicine.find({});
    
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        medicines: {
          total: finalMedicines.length,
          with_hsn: finalMedicines.filter(m => m.hsn_code).length,
          with_gst: finalMedicines.filter(m => m.gst_rate !== undefined).length
        },
        batches: {
          total: finalBatches.length,
          active: finalBatches.filter(b => b.is_active).length,
          expired: finalBatches.filter(b => !b.is_active).length,
          with_tax_snapshot: finalBatches.filter(b => b.tax_snapshot).length
        },
        fixes_applied: {
          medicines_updated: medicinesUpdated,
          gst_rate_fields_removed: removeResult.modifiedCount,
          expiry_dates_fixed: expiredFixed,
          quantities_fixed: quantitiesFixed,
          prices_fixed: pricesFixed,
          tax_snapshots_updated: taxSnapshotsUpdated,
          expired_marked_inactive: expiredResult.modifiedCount,
          units_per_pack_fixed: unitsFixed
        },
        stock_summary: {
          total_quantity: finalBatches.reduce((sum, b) => sum + (b.quantity || 0), 0),
          low_stock_batches: finalBatches.filter(b => b.quantity < LOW_STOCK_THRESHOLD && b.is_active).length,
          expired_stock: finalBatches.filter(b => !b.is_active).reduce((sum, b) => sum + (b.quantity || 0), 0)
        }
      },
      backups: {
        medicines: medicineBackupFile,
        batches: batchBackupFile
      }
    };
    
    const reportDir = path.join(__dirname, '../reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
    
    const reportFile = path.join(reportDir, `full_fix_report_${timestamp}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`  ✓ Report saved to: ${reportFile}`);

    // ==================== FINAL SUMMARY ====================
    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL FIXES COMPLETED SUCCESSFULLY');
    console.log('='.repeat(60));
    console.log('\n📊 FINAL SUMMARY:');
    console.log('-'.repeat(40));
    console.log(`Medicines: ${finalMedicines.length} total`);
    console.log(`  • With HSN: ${report.summary.medicines.with_hsn}`);
    console.log(`  • With GST: ${report.summary.medicines.with_gst}`);
    console.log(`\nBatches: ${finalBatches.length} total`);
    console.log(`  • Active: ${report.summary.batches.active}`);
    console.log(`  • Expired/Inactive: ${report.summary.batches.expired}`);
    console.log(`  • With tax snapshot: ${report.summary.batches.with_tax_snapshot}`);
    console.log(`\nStock: ${report.summary.stock_summary.total_quantity} total units`);
    console.log(`  • Low stock batches: ${report.summary.stock_summary.low_stock_batches}`);
    console.log(`  • Expired stock: ${report.summary.stock_summary.expired_stock} units`);
    console.log('\n' + '='.repeat(60));
    console.log(`\n💾 Backups saved to: ${backupDir}`);
    console.log(`📄 Report saved to: ${reportFile}`);
    console.log('\n✨ All data has been fixed!');

  } catch (error) {
    console.error('\n❌ ERROR:', error);
    console.log('\n⚠️ To restore from backup, use:');
    console.log(`  mongorestore --db HMS --collection medicines ${backupMedicines.length > 0 ? '(manual restore needed)' : ''}`);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// Run the fix
if (require.main === module) {
  console.log('\n🛠️  MEDICINE DATA FIX TOOL');
  console.log('This script will fix:');
  console.log('  • Missing HSN/GST codes');
  console.log('  • Expired expiry dates (extend by 1 year)');
  console.log('  • Zero/null quantities (set to 100)');
  console.log('  • Price calculation errors');
  console.log('  • Missing tax snapshots');
  console.log('  • And more...\n');
  
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  rl.question('⚠️  This will modify your database. Create backup first? (yes/no): ', async (answer) => {
    if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
      rl.close();
      await fixAllData();
      process.exit(0);
    } else {
      console.log('Operation cancelled.');
      rl.close();
      process.exit(0);
    }
  });
}

module.exports = { fixAllData };