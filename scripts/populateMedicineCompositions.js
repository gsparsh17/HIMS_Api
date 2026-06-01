/**
 * Script to populate composition field for existing medicines
 * 
 * Run with: node scripts/populateMedicineCompositions.js
 * 
 * This script:
 * 1. Fetches all medicines without composition data
 * 2. Searches NLEM API for matching medicines
 * 3. Updates composition, generic_name, and strength fields
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Medicine Schema (simplified for the script)
const medicineSchema = new mongoose.Schema({
  name: { type: String, required: true },
  generic_name: { type: String, default: '' },
  composition: { type: String, default: '' },
  strength: { type: String, default: '' },
  brand: { type: String, default: '' },
  category: { type: String },
  is_active: { type: Boolean, default: true }
});

const Medicine = mongoose.model('Medicine', medicineSchema);

// NLEM Medicine Schema
const nlemMedicineSchema = new mongoose.Schema({
  medicine_name: { type: String },
  generic_name: { type: String },
  strength: { type: String },
  dosage_form: { type: String },
  therapeutic_category: { type: String },
  nlem_code: { type: String }
});

const NLEMMedicine = mongoose.model('NLEMMedicine', nlemMedicineSchema, 'nlemmedicines');

// Common medicine name mappings for better matching
const nameMappings = {
  'dolo': 'Paracetamol',
  'paracetamol': 'Paracetamol',
  'crocin': 'Paracetamol',
  'calpol': 'Paracetamol',
  'metacin': 'Paracetamol',
  'abacavir': 'Abacavir',
  'ziagen': 'Abacavir',
  'ivermectin': 'Ivermectin',
  'stromectol': 'Ivermectin',
  'artesunate': 'Artesunate',
  'artesunate injection': 'Artesunate',
  'chlorhexidine': 'Chlorhexidine',
  'savlon': 'Chlorhexidine',
  'acetazolamide': 'Acetazolamide',
  'diamox': 'Acetazolamide',
  'benzoyl peroxide': 'Benzoyl peroxide',
  'benzac': 'Benzoyl peroxide',
  'baclofen': 'Baclofen',
  'lioresal': 'Baclofen',
  'gadobenate dimeglumine': 'Gadobenate dimeglumine',
  'multihance': 'Gadobenate dimeglumine',
  'betamethasone': 'Betamethasone',
  'celestone': 'Betamethasone',
  'salicylic acid': 'Salicylic acid',
  'clindamycin': 'Clindamycin',
  'cleocin': 'Clindamycin',
  'acyclovir': 'Acyclovir',
  'zovirax': 'Acyclovir',
  'albendazole': 'Albendazole',
  'zentel': 'Albendazole',
  'allopurinol': 'Allopurinol',
  'zyloric': 'Allopurinol'
};

// Composition mappings for common medicines
const compositionMappings = {
  'Paracetamol': 'Paracetamol',
  'Abacavir': 'Abacavir',
  'Ivermectin': 'Ivermectin',
  'Artesunate': 'Artesunate',
  'Chlorhexidine': 'Chlorhexidine Gluconate',
  'Acetazolamide': 'Acetazolamide',
  'Benzoyl peroxide': 'Benzoyl Peroxide',
  'Baclofen': 'Baclofen',
  'Gadobenate dimeglumine': 'Gadobenate Dimeglumine',
  'Betamethasone': 'Betamethasone',
  'Salicylic acid': 'Salicylic Acid',
  'Clindamycin': 'Clindamycin',
  'Acyclovir': 'Acyclovir',
  'Albendazole': 'Albendazole',
  'Allopurinol': 'Allopurinol'
};

// Generic name mappings
const genericNameMappings = {
  'Paracetamol': 'Acetaminophen',
  'Abacavir': 'Abacavir',
  'Ivermectin': 'Ivermectin',
  'Artesunate': 'Artesunate',
  'Chlorhexidine': 'Chlorhexidine',
  'Acetazolamide': 'Acetazolamide',
  'Benzoyl peroxide': 'Benzoyl Peroxide',
  'Baclofen': 'Baclofen',
  'Gadobenate dimeglumine': 'Gadobenate Dimeglumine',
  'Betamethasone': 'Betamethasone',
  'Salicylic acid': 'Salicylic Acid',
  'Clindamycin': 'Clindamycin',
  'Acyclovir': 'Acyclovir',
  'Albendazole': 'Albendazole',
  'Allopurinol': 'Allopurinol'
};

// Helper function to normalize medicine name for matching
function normalizeName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

// Helper function to find best match from NLEM data
async function findNLEMMatch(medicineName) {
  try {
    // First, try exact match
    let match = await NLEMMedicine.findOne({ 
      medicine_name: { $regex: new RegExp(`^${medicineName}$`, 'i') }
    });
    
    if (match) return match;
    
    // Try partial match
    match = await NLEMMedicine.findOne({ 
      medicine_name: { $regex: medicineName, $options: 'i' }
    });
    
    if (match) return match;
    
    // Try searching by generic name
    const mappedName = nameMappings[medicineName.toLowerCase()] || medicineName;
    match = await NLEMMedicine.findOne({ 
      $or: [
        { medicine_name: { $regex: mappedName, $options: 'i' } },
        { generic_name: { $regex: mappedName, $options: 'i' } }
      ]
    });
    
    return match;
  } catch (error) {
    console.error(`Error searching NLEM for ${medicineName}:`, error.message);
    return null;
  }
}

// Main function to populate compositions
async function populateCompositions() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hims';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');
    
    // Find medicines without composition or with empty composition
    const medicines = await Medicine.find({
      $or: [
        { composition: { $exists: false } },
        { composition: '' },
        { composition: null }
      ]
    });
    
    console.log(`📊 Found ${medicines.length} medicines without composition data\n`);
    
    let updated = 0;
    let skipped = 0;
    let errors = [];
    
    for (const medicine of medicines) {
      console.log(`\n🔍 Processing: ${medicine.name}`);
      
      // Skip if name is too generic or invalid
      if (!medicine.name || medicine.name.length < 2) {
        console.log(`   ⏭️ Skipping - invalid name`);
        skipped++;
        continue;
      }
      
      // Get mapped name for better matching
      const mappedName = nameMappings[medicine.name.toLowerCase()] || medicine.name;
      console.log(`   📝 Mapped name: ${mappedName}`);
      
      // Try to find composition from mapping first
      let composition = compositionMappings[mappedName];
      let genericName = genericNameMappings[mappedName];
      let strength = medicine.strength;
      
      // If not in mapping, try NLEM database
      if (!composition) {
        const nlemMatch = await findNLEMMatch(medicine.name);
        
        if (nlemMatch) {
          composition = nlemMatch.generic_name || nlemMatch.medicine_name;
          genericName = nlemMatch.generic_name || composition;
          strength = nlemMatch.strength || medicine.strength;
          console.log(`   ✅ Found in NLEM: ${composition}`);
        } else {
          // Use name as composition if no match found
          composition = medicine.generic_name || medicine.name;
          console.log(`   ⚠️ No NLEM match, using name as composition`);
        }
      } else {
        console.log(`   ✅ Using mapping: ${composition}`);
      }
      
      // Prepare update data
      const updateData = {
        composition: composition,
        generic_name: genericName || medicine.generic_name || composition
      };
      
      // Only update strength if it's empty
      if (!medicine.strength || medicine.strength === '') {
        if (strength) {
          updateData.strength = strength;
          console.log(`   📊 Updated strength: ${strength}`);
        }
      } else {
        console.log(`   📊 Existing strength: ${medicine.strength}`);
      }
      
      // Update the medicine
      try {
        await Medicine.updateOne(
          { _id: medicine._id },
          { $set: updateData }
        );
        console.log(`   ✅ Updated: ${medicine.name} -> composition: ${composition}`);
        updated++;
      } catch (updateError) {
        console.error(`   ❌ Update failed: ${updateError.message}`);
        errors.push({ name: medicine.name, error: updateError.message });
      }
    }
    
    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 COMPOSITION POPULATION COMPLETE');
    console.log('='.repeat(60));
    console.log(`✅ Updated: ${updated} medicines`);
    console.log(`⏭️ Skipped: ${skipped} medicines`);
    console.log(`❌ Errors: ${errors.length} medicines`);
    
    if (errors.length > 0) {
      console.log('\n⚠️ Errors encountered:');
      errors.forEach(err => {
        console.log(`   - ${err.name}: ${err.error}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// Alternative script to populate from NLEM database only
async function populateFromNLEMOnly() {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/hims';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');
    
    // Get all NLEM medicines
    const nlemMedicines = await NLEMMedicine.find({});
    console.log(`📊 Found ${nlemMedicines.length} NLEM medicines`);
    
    // Create a map for quick lookup
    const nlemMap = new Map();
    nlemMedicines.forEach(nlem => {
      const key = nlem.medicine_name.toLowerCase();
      if (!nlemMap.has(key) || nlemMap.get(key).generic_name) {
        nlemMap.set(key, nlem);
      }
    });
    
    // Find medicines without composition
    const medicines = await Medicine.find({
      $or: [
        { composition: { $exists: false } },
        { composition: '' },
        { composition: null }
      ]
    });
    
    console.log(`📊 Found ${medicines.length} medicines to update\n`);
    
    let updated = 0;
    
    for (const medicine of medicines) {
      const normalizedName = normalizeName(medicine.name);
      let bestMatch = null;
      
      // Try to find best match
      for (const [key, nlem] of nlemMap) {
        if (key.includes(normalizedName) || normalizedName.includes(key)) {
          bestMatch = nlem;
          break;
        }
      }
      
      if (bestMatch) {
        await Medicine.updateOne(
          { _id: medicine._id },
          {
            $set: {
              composition: bestMatch.generic_name || bestMatch.medicine_name,
              generic_name: bestMatch.generic_name || medicine.generic_name,
              strength: bestMatch.strength || medicine.strength
            }
          }
        );
        console.log(`✅ Updated: ${medicine.name} -> ${bestMatch.generic_name || bestMatch.medicine_name}`);
        updated++;
      } else {
        console.log(`⚠️ No match found for: ${medicine.name}`);
      }
    }
    
    console.log(`\n✅ Updated ${updated} medicines`);
    
  } catch (error) {
    console.error('❌ Script failed:', error);
  } finally {
    await mongoose.disconnect();
  }
}

// Export for use in other scripts
module.exports = { populateCompositions, populateFromNLEMOnly };

// Run the script if called directly
if (require.main === module) {
  console.log('🚀 Starting medicine composition population script...\n');
  populateCompositions();
}