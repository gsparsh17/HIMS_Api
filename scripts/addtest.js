const mongoose = require('mongoose');
require('dotenv').config(); // Make sure to have dotenv installed

const connectDB = require('../config/db'); // Update with actual path
const ImagingTest = require('../models/ImagingTest'); // Update with actual path

// Sample imaging tests data
const imagingTestsData = [
  {
    code: 'XR-CHEST-002',
    name: 'Chest X-Ray (PA View)',
    category: 'X-Ray',
    description: 'Posteroanterior view chest X-ray for lung and heart evaluation',
    preparation_instructions: 'No special preparation required. Remove jewelry and metal objects from chest area.',
    contraindications: 'Pregnancy (inform radiologist)',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 4,
    base_price: 1200,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'XR-ABDOMEN-001',
    name: 'Abdominal X-Ray',
    category: 'X-Ray',
    description: 'Plain abdominal X-ray for evaluation of abdominal organs and detection of abnormalities',
    preparation_instructions: 'Fasting for 4-6 hours before the test. Empty bladder before the procedure.',
    contraindications: 'Pregnancy',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 4,
    base_price: 1500,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'XR-SPINE-001',
    name: 'Spine X-Ray (Lumbar)',
    category: 'X-Ray',
    description: 'Lumbar spine X-ray for evaluation of spinal alignment and abnormalities',
    preparation_instructions: 'No special preparation required. Wear comfortable clothing.',
    contraindications: 'Pregnancy',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 6,
    base_price: 1800,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'CT-BRAIN-001',
    name: 'CT Scan Brain',
    category: 'CT Scan',
    description: 'Computed Tomography scan of the brain for detection of abnormalities, tumors, or bleeding',
    preparation_instructions: 'Fasting for 4 hours before the test. Inform about any allergies or kidney problems.',
    contraindications: 'Pregnancy, severe kidney disease (contrast may be used)',
    contrast_required: true,
    contrast_details: 'Iodinated contrast may be used for better visualization',
    turnaround_time_hours: 8,
    base_price: 5000,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'CT-CHEST-001',
    name: 'CT Scan Chest',
    category: 'CT Scan',
    description: 'Chest CT scan for detailed evaluation of lungs, mediastinum, and chest structures',
    preparation_instructions: 'Fasting for 4 hours. Remove metal objects from chest area.',
    contraindications: 'Pregnancy, severe renal impairment',
    contrast_required: true,
    contrast_details: 'IV contrast may be administered for vascular evaluation',
    turnaround_time_hours: 8,
    base_price: 5500,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'MRI-BRAIN-001',
    name: 'MRI Brain',
    category: 'MRI',
    description: 'Magnetic Resonance Imaging of the brain for detailed neurological evaluation',
    preparation_instructions: 'Remove all metal objects. Inform about any implants or pacemakers. Fasting for 4 hours.',
    contraindications: 'Metal implants, pacemakers, severe claustrophobia',
    contrast_required: true,
    contrast_details: 'Gadolinium-based contrast may be used for better lesion detection',
    turnaround_time_hours: 12,
    base_price: 8000,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'MRI-KNEE-001',
    name: 'MRI Knee',
    category: 'MRI',
    description: 'Knee MRI for evaluation of ligaments, menisci, and soft tissue structures',
    preparation_instructions: 'No special preparation required. Remove metal objects.',
    contraindications: 'Metal implants in the area',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 10,
    base_price: 6000,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'US-ABDOMEN-001',
    name: 'Ultrasound Abdomen',
    category: 'Ultrasound',
    description: 'Abdominal ultrasound for evaluation of liver, gallbladder, pancreas, spleen, and kidneys',
    preparation_instructions: 'Fasting for 8-12 hours. Drink 1 liter of water 1 hour before the test (hold bladder).',
    contraindications: 'None',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 4,
    base_price: 3000,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'US-PELVIC-001',
    name: 'Pelvic Ultrasound',
    category: 'Ultrasound',
    description: 'Pelvic ultrasound for evaluation of reproductive organs and pelvic structures',
    preparation_instructions: 'Drink 1 liter of water 1 hour before the test. Hold bladder during the procedure.',
    contraindications: 'None',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 4,
    base_price: 2800,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'ECG-001',
    name: 'Electrocardiogram (ECG)',
    category: 'ECG',
    description: 'ECG for evaluation of cardiac electrical activity and rhythm',
    preparation_instructions: 'Avoid caffeine before the test. Wear loose clothing.',
    contraindications: 'None',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 2,
    base_price: 800,
    insurance_coverage: 'Full',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'ECHO-001',
    name: 'Echocardiography',
    category: 'Echocardiography',
    description: 'Echocardiogram for evaluation of heart structure and function',
    preparation_instructions: 'No special preparation required. Wear loose clothing.',
    contraindications: 'None',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 6,
    base_price: 3500,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'MAMMO-001',
    name: 'Mammography',
    category: 'Mammography',
    description: 'Screening mammogram for breast cancer detection',
    preparation_instructions: 'Avoid using deodorant or lotion on the day of the test. Schedule after menstruation.',
    contraindications: 'Pregnancy',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 6,
    base_price: 2500,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'PET-BODY-001',
    name: 'PET Scan Full Body',
    category: 'PET Scan',
    description: 'Full body PET scan for metabolic evaluation and cancer detection',
    preparation_instructions: 'Fasting for 6 hours. Avoid exercise for 24 hours. Stay warm and relaxed.',
    contraindications: 'Pregnancy, uncontrolled diabetes',
    contrast_required: true,
    contrast_details: 'FDG (radioactive tracer) injection before the scan',
    turnaround_time_hours: 12,
    base_price: 15000,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'DEXA-001',
    name: 'DEXA Scan (Bone Density)',
    category: 'DEXA Scan',
    description: 'Bone density scan for osteoporosis screening and evaluation',
    preparation_instructions: 'Avoid calcium supplements for 24 hours. Wear loose clothing without metal.',
    contraindications: 'Pregnancy',
    contrast_required: false,
    contrast_details: '',
    turnaround_time_hours: 4,
    base_price: 2000,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  },
  {
    code: 'FLUORO-001',
    name: 'Barium Swallow',
    category: 'Fluoroscopy',
    description: 'Fluoroscopic study of the esophagus using barium contrast',
    preparation_instructions: 'Fasting for 8 hours before the test.',
    contraindications: 'Suspected perforation, severe dysphagia',
    contrast_required: true,
    contrast_details: 'Barium sulfate oral contrast',
    turnaround_time_hours: 6,
    base_price: 4000,
    insurance_coverage: 'Partial',
    is_active: true,
    usage_count: 0
  }
];

// Function to seed imaging tests
const seedImagingTests = async () => {
  try {
    // Connect to MongoDB
    await connectDB();
    
    console.log('🌱 Starting imaging tests seeding...');
    
    let insertedCount = 0;
    let skippedCount = 0;
    
    // Process each imaging test
    for (const testData of imagingTestsData) {
      try {
        // Check if a test with the same code already exists (and hospitalId is not set - assuming global tests)
        const existingTest = await ImagingTest.findOne({ 
          code: testData.code,
          hospitalId: null // or undefined, adjust based on your needs
        });
        
        if (existingTest) {
          console.log(`⏭️ Skipping duplicate: ${testData.code} - ${testData.name}`);
          skippedCount++;
          continue;
        }
        
        // Create new imaging test
        const newTest = new ImagingTest(testData);
        await newTest.save();
        console.log(`✅ Added: ${testData.code} - ${testData.name}`);
        insertedCount++;
      } catch (error) {
        console.error(`❌ Error adding ${testData.code}:`, error.message);
      }
    }
    
    console.log('\n📊 Seeding Summary:');
    console.log(`   ✅ Inserted: ${insertedCount} new imaging tests`);
    console.log(`   ⏭️ Skipped: ${skippedCount} duplicate tests`);
    
    // Verify all tests (optional)
    const totalTests = await ImagingTest.countDocuments();
    console.log(`   📋 Total imaging tests in database: ${totalTests}`);
    
  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('📌 MongoDB connection closed');
  }
};

// Run the seeding function
seedImagingTests();

// Export for potential reuse
module.exports = seedImagingTests;