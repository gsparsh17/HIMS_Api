// scripts/createSampleRoomsWardsBeds.js
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

// Import models (IN THE CORRECT ORDER)
const Department = require('../models/Department');
const Ward = require('../models/Ward');
const Room = require('../models/Room');
const Bed = require('../models/Bed');

// Sample data configuration
const SAMPLE_DATA = {
  wards: [
    {
      name: 'General Ward',
      type: 'General',
      floor: 'Ground Floor',
      description: 'General patient ward with 20 beds',
      departmentName: 'Emergency Department'
    },
    {
      name: 'ICU',
      type: 'ICU',
      floor: 'First Floor',
      description: 'Intensive Care Unit with critical care facilities',
      departmentName: 'Emergency Department'
    },
    {
      name: 'Maternity Ward',
      type: 'Maternity',
      floor: 'Second Floor',
      description: 'Maternity and childbirth unit',
      departmentName: 'Emergency Department'
    },
    {
      name: 'Pediatric Ward',
      type: 'Pediatric',
      floor: 'Second Floor',
      description: "Children's ward with pediatric care",
      departmentName: 'Emergency Department'
    },
    {
      name: 'Surgical Ward',
      type: 'Surgical',
      floor: 'Third Floor',
      description: 'Post-operative surgical recovery ward',
      departmentName: 'Emergency Department'
    },
    {
      name: 'Private Suite',
      type: 'General',
      floor: 'Fourth Floor',
      description: 'Premium private rooms with attached bathrooms',
      departmentName: 'Emergency Department'
    },
    {
      name: 'Cardiology Ward',
      type: 'General',
      floor: 'First Floor',
      description: 'Cardiac care unit',
      departmentName: 'Cardiology'
    },
    {
      name: 'Neurology Ward',
      type: 'General',
      floor: 'Second Floor',
      description: 'Neurology and neurosurgery unit',
      departmentName: 'Neurology'
    },
    {
      name: 'Orthopedic Ward',
      type: 'General',
      floor: 'Third Floor',
      description: 'Orthopedic and trauma unit',
      departmentName: 'Orthopedics'
    }
  ],
  rooms: [
    // General Ward Rooms
    { roomNumber: 'G101', type: 'General', floor: 'Ground Floor', wardName: 'General Ward', bedCount: 4, bedType: 'General', dailyCharge: 800 },
    { roomNumber: 'G102', type: 'General', floor: 'Ground Floor', wardName: 'General Ward', bedCount: 4, bedType: 'General', dailyCharge: 800 },
    { roomNumber: 'G103', type: 'General', floor: 'Ground Floor', wardName: 'General Ward', bedCount: 4, bedType: 'General', dailyCharge: 800 },
    { roomNumber: 'G104', type: 'General', floor: 'Ground Floor', wardName: 'General Ward', bedCount: 4, bedType: 'General', dailyCharge: 800 },
    { roomNumber: 'G105', type: 'General', floor: 'Ground Floor', wardName: 'General Ward', bedCount: 4, bedType: 'General', dailyCharge: 800 },
    
    // ICU Rooms
    { roomNumber: 'ICU101', type: 'ICU', floor: 'First Floor', wardName: 'ICU', bedCount: 2, bedType: 'ICU', dailyCharge: 5000 },
    { roomNumber: 'ICU102', type: 'ICU', floor: 'First Floor', wardName: 'ICU', bedCount: 2, bedType: 'ICU', dailyCharge: 5000 },
    { roomNumber: 'ICU103', type: 'ICU', floor: 'First Floor', wardName: 'ICU', bedCount: 2, bedType: 'ICU', dailyCharge: 5000 },
    
    // Maternity Ward Rooms
    { roomNumber: 'MAT101', type: 'General', floor: 'Second Floor', wardName: 'Maternity Ward', bedCount: 4, bedType: 'General', dailyCharge: 1200 },
    { roomNumber: 'MAT102', type: 'General', floor: 'Second Floor', wardName: 'Maternity Ward', bedCount: 4, bedType: 'General', dailyCharge: 1200 },
    { roomNumber: 'MAT103', type: 'General', floor: 'Second Floor', wardName: 'Maternity Ward', bedCount: 4, bedType: 'General', dailyCharge: 1200 },
    
    // Pediatric Ward Rooms
    { roomNumber: 'PED101', type: 'General', floor: 'Second Floor', wardName: 'Pediatric Ward', bedCount: 4, bedType: 'General', dailyCharge: 1000 },
    { roomNumber: 'PED102', type: 'General', floor: 'Second Floor', wardName: 'Pediatric Ward', bedCount: 4, bedType: 'General', dailyCharge: 1000 },
    { roomNumber: 'PED103', type: 'General', floor: 'Second Floor', wardName: 'Pediatric Ward', bedCount: 4, bedType: 'General', dailyCharge: 1000 },
    
    // Surgical Ward Rooms
    { roomNumber: 'SUR101', type: 'General', floor: 'Third Floor', wardName: 'Surgical Ward', bedCount: 4, bedType: 'General', dailyCharge: 1200 },
    { roomNumber: 'SUR102', type: 'General', floor: 'Third Floor', wardName: 'Surgical Ward', bedCount: 4, bedType: 'General', dailyCharge: 1200 },
    { roomNumber: 'SUR103', type: 'General', floor: 'Third Floor', wardName: 'Surgical Ward', bedCount: 4, bedType: 'General', dailyCharge: 1200 },
    
    // Cardiology Ward Rooms
    { roomNumber: 'CAR101', type: 'General', floor: 'First Floor', wardName: 'Cardiology Ward', bedCount: 4, bedType: 'General', dailyCharge: 1500 },
    { roomNumber: 'CAR102', type: 'General', floor: 'First Floor', wardName: 'Cardiology Ward', bedCount: 4, bedType: 'General', dailyCharge: 1500 },
    
    // Neurology Ward Rooms
    { roomNumber: 'NEU101', type: 'General', floor: 'Second Floor', wardName: 'Neurology Ward', bedCount: 4, bedType: 'General', dailyCharge: 1500 },
    { roomNumber: 'NEU102', type: 'General', floor: 'Second Floor', wardName: 'Neurology Ward', bedCount: 4, bedType: 'General', dailyCharge: 1500 },
    
    // Orthopedic Ward Rooms
    { roomNumber: 'ORT101', type: 'General', floor: 'Third Floor', wardName: 'Orthopedic Ward', bedCount: 4, bedType: 'General', dailyCharge: 1500 },
    { roomNumber: 'ORT102', type: 'General', floor: 'Third Floor', wardName: 'Orthopedic Ward', bedCount: 4, bedType: 'General', dailyCharge: 1500 },
    
    // Private Suite Rooms
    { roomNumber: 'PRI101', type: 'Private', floor: 'Fourth Floor', wardName: 'Private Suite', bedCount: 1, bedType: 'Private', dailyCharge: 5000 },
    { roomNumber: 'PRI102', type: 'Private', floor: 'Fourth Floor', wardName: 'Private Suite', bedCount: 1, bedType: 'Private', dailyCharge: 5000 },
    { roomNumber: 'PRI103', type: 'Private', floor: 'Fourth Floor', wardName: 'Private Suite', bedCount: 1, bedType: 'Private', dailyCharge: 5000 },
    { roomNumber: 'PRI104', type: 'Private', floor: 'Fourth Floor', wardName: 'Private Suite', bedCount: 1, bedType: 'Private', dailyCharge: 5000 },
    { roomNumber: 'PRI105', type: 'Private', floor: 'Fourth Floor', wardName: 'Private Suite', bedCount: 1, bedType: 'Private', dailyCharge: 5000 },
    
    // Operation Theaters
    { roomNumber: 'OT101', type: 'Operation Theater', floor: 'First Floor', wardName: null, bedCount: 0, bedType: null, dailyCharge: 0, isOT: true },
    { roomNumber: 'OT102', type: 'Operation Theater', floor: 'First Floor', wardName: null, bedCount: 0, bedType: null, dailyCharge: 0, isOT: true },
    { roomNumber: 'OT103', type: 'Operation Theater', floor: 'Second Floor', wardName: null, bedCount: 0, bedType: null, dailyCharge: 0, isOT: true }
  ]
};

// Department name to ID mapping
const departmentMap = {};

async function getDepartmentId(departmentName) {
  if (departmentMap[departmentName]) return departmentMap[departmentName];
  
  try {
    const department = await Department.findOne({ name: departmentName });
    if (department) {
      departmentMap[departmentName] = department._id;
      return department._id;
    }
    console.log(`  ⚠️ Department "${departmentName}" not found, creating without department`);
    return null;
  } catch (error) {
    console.error(`  Error finding department "${departmentName}":`, error.message);
    return null;
  }
}

async function createWards() {
  console.log('\n📋 Creating wards...');
  const createdWards = [];
  const wardMap = {};

  for (const wardData of SAMPLE_DATA.wards) {
    // Check if ward already exists
    const existingWard = await Ward.findOne({ name: wardData.name });
    
    if (existingWard) {
      console.log(`  ⏭️ Ward "${wardData.name}" already exists, skipping...`);
      wardMap[wardData.name] = existingWard;
      createdWards.push(existingWard);
      continue;
    }

    // Get department ID
    const departmentId = await getDepartmentId(wardData.departmentName);
    
    const ward = new Ward({
      name: wardData.name,
      type: wardData.type,
      floor: wardData.floor,
      description: wardData.description,
      departmentId: departmentId,
      isActive: true
    });

    await ward.save();
    console.log(`  ✅ Created ward: ${wardData.name} (${ward.code}) - ${wardData.type} Ward`);
    wardMap[wardData.name] = ward;
    createdWards.push(ward);
  }

  return { createdWards, wardMap };
}

async function createRooms(wardMap) {
  console.log('\n📋 Creating rooms...');
  const createdRooms = [];
  const roomMap = {};

  // First, get existing rooms to avoid duplicates
  const existingRooms = await Room.find({});
  const existingRoomNumbers = new Set(existingRooms.map(r => r.room_number));

  for (const roomData of SAMPLE_DATA.rooms) {
    // Skip if room already exists
    if (existingRoomNumbers.has(roomData.roomNumber)) {
      console.log(`  ⏭️ Room "${roomData.roomNumber}" already exists, skipping...`);
      const existingRoom = existingRooms.find(r => r.room_number === roomData.roomNumber);
      if (existingRoom) {
        roomMap[roomData.roomNumber] = existingRoom;
        createdRooms.push(existingRoom);
      }
      continue;
    }

    // Get ward ID if applicable
    let wardId = null;
    if (roomData.wardName && wardMap[roomData.wardName]) {
      wardId = wardMap[roomData.wardName]._id;
    }

    // Get department ID for OT rooms
    let departmentId = null;
    if (roomData.isOT) {
      departmentId = await getDepartmentId('Emergency Department');
    }

    const room = new Room({
      room_number: roomData.roomNumber,
      wardId: wardId,
      type: roomData.type,
      Department: departmentId,
      status: 'Available',
      floor: roomData.floor,
      description: `${roomData.type} Room${roomData.bedCount > 0 ? ` with ${roomData.bedCount} beds` : ''}`
    });

    await room.save();
    console.log(`  ✅ Created room: ${roomData.roomNumber} (${roomData.type}) - ${roomData.floor}`);
    roomMap[roomData.roomNumber] = room;
    createdRooms.push(room);
  }

  return { createdRooms, roomMap };
}

async function createBeds(roomMap, wardMap) {
  console.log('\n🛏️ Creating beds...');
  const createdBeds = [];
  
  // Get existing beds to avoid duplicates
  const existingBeds = await Bed.find({});
  const existingBedNumbers = new Set(existingBeds.map(b => b.bedNumber));

  for (const roomData of SAMPLE_DATA.rooms) {
    const room = roomMap[roomData.roomNumber];
    if (!room) {
      console.log(`  ⚠️ Room "${roomData.roomNumber}" not found, skipping bed creation...`);
      continue;
    }

    // Skip OT rooms (no beds)
    if (roomData.isOT || roomData.bedCount === 0) {
      continue;
    }

    const ward = roomData.wardName ? wardMap[roomData.wardName] : null;
    
    // Define features based on bed type
    let features = [];
    switch (roomData.bedType) {
      case 'ICU':
        features = ['Ventilator', 'Multi-parameter Monitor', 'Suction Apparatus', 'Infusion Pump', 'Central Oxygen'];
        break;
      case 'Private':
        features = ['Attached Bathroom', 'LED TV', 'Air Conditioner', 'Mini Fridge', 'WiFi', 'Patient Call Bell'];
        break;
      case 'General':
      default:
        features = ['Attached Bathroom', 'Patient Call Bell', 'Bedside Locker', 'Reading Light'];
        break;
    }

    for (let i = 1; i <= roomData.bedCount; i++) {
      const bedNumber = `${roomData.roomNumber}-${String(i).padStart(2, '0')}`;
      
      // Skip if bed already exists
      if (existingBedNumbers.has(bedNumber)) {
        console.log(`  ⏭️ Bed "${bedNumber}" already exists, skipping...`);
        continue;
      }

      const bed = new Bed({
        bedNumber: bedNumber,
        roomId: room._id,
        wardId: ward ? ward._id : null,
        bedType: roomData.bedType,
        status: 'Available',
        dailyCharge: roomData.dailyCharge,
        features: features,
        isActive: true
      });

      await bed.save();
      console.log(`  ✅ Created bed: ${bedNumber} (${roomData.bedType}) - ₹${roomData.dailyCharge}/day`);
      createdBeds.push(bed);
    }
  }

  return createdBeds;
}

async function createOperationTheaterRecoveryBeds(roomMap) {
  console.log('\n🏥 Creating Operation Theater recovery beds...');
  const createdBeds = [];
  
  const existingBeds = await Bed.find({});
  const existingBedNumbers = new Set(existingBeds.map(b => b.bedNumber));

  // Create recovery beds for OT rooms
  const otRooms = Object.values(roomMap).filter(room => room.type === 'Operation Theater');
  
  for (const otRoom of otRooms) {
    for (let i = 1; i <= 2; i++) {
      const bedNumber = `${otRoom.room_number}-REC-${i}`;
      
      if (existingBedNumbers.has(bedNumber)) {
        console.log(`  ⏭️ Recovery bed "${bedNumber}" already exists, skipping...`);
        continue;
      }

      const bed = new Bed({
        bedNumber: bedNumber,
        roomId: otRoom._id,
        wardId: null,
        bedType: 'General',
        status: 'Available',
        dailyCharge: 1500,
        features: ['Recovery Bed', 'Patient Monitor', 'Oxygen Support', 'Suction Unit', 'Emergency Call Bell'],
        isActive: true
      });

      await bed.save();
      console.log(`  ✅ Created recovery bed: ${bedNumber} - ₹1500/day`);
      createdBeds.push(bed);
    }
  }

  return createdBeds;
}

async function printSummary(wards, rooms, beds, recoveryBeds) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 CREATION SUMMARY');
  console.log('='.repeat(70));
  
  console.log(`\n🏥 Wards Created: ${wards.length}`);
  wards.forEach(ward => {
    console.log(`   - ${ward.name} (${ward.code}) - ${ward.type} Ward - Floor: ${ward.floor || 'N/A'}`);
  });
  
  console.log(`\n🚪 Rooms Created: ${rooms.length}`);
  const roomsByType = {};
  const roomsByFloor = {};
  rooms.forEach(room => {
    roomsByType[room.type] = (roomsByType[room.type] || 0) + 1;
    const floor = room.floor || 'N/A';
    roomsByFloor[floor] = (roomsByFloor[floor] || 0) + 1;
  });
  console.log('   By Type:');
  Object.entries(roomsByType).forEach(([type, count]) => {
    console.log(`      - ${type}: ${count} rooms`);
  });
  console.log('   By Floor:');
  Object.entries(roomsByFloor).forEach(([floor, count]) => {
    console.log(`      - ${floor}: ${count} rooms`);
  });
  
  console.log(`\n🛏️ Regular Beds Created: ${beds.length}`);
  const bedsByType = {};
  beds.forEach(bed => {
    bedsByType[bed.bedType] = (bedsByType[bed.bedType] || 0) + 1;
  });
  Object.entries(bedsByType).forEach(([type, count]) => {
    console.log(`   - ${type}: ${count} beds`);
  });
  
  if (recoveryBeds.length > 0) {
    console.log(`\n🛏️ Recovery Beds Created: ${recoveryBeds.length}`);
  }
  
  const totalBeds = beds.length + recoveryBeds.length;
  console.log(`\n📈 Total Beds Available: ${totalBeds}`);
  
  // Calculate capacity by ward
  console.log('\n🏥 Ward Capacity Breakdown:');
  const wardsWithBeds = {};
  [...beds, ...recoveryBeds].forEach(bed => {
    if (bed.wardId) {
      const wardId = bed.wardId.toString();
      wardsWithBeds[wardId] = (wardsWithBeds[wardId] || 0) + 1;
    }
  });
  
  for (const ward of wards) {
    const bedCount = wardsWithBeds[ward._id.toString()] || 0;
    console.log(`   - ${ward.name}: ${bedCount} beds`);
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('✅ Setup completed successfully!');
  console.log('='.repeat(70));
}

async function main() {
  try {
    console.log('🚀 Starting sample data creation...');
    console.log('📁 Connecting to MongoDB...');
    
    await connectDB();
    console.log('✅ Connected to MongoDB\n');
    
    // Verify Department model is loaded
    console.log('📋 Checking models...');
    console.log(`   Department model: ${Department ? 'Loaded' : 'Not loaded'}`);
    console.log(`   Ward model: ${Ward ? 'Loaded' : 'Not loaded'}`);
    console.log(`   Room model: ${Room ? 'Loaded' : 'Not loaded'}`);
    console.log(`   Bed model: ${Bed ? 'Loaded' : 'Not loaded'}`);
    
    // List existing departments for reference
    const existingDepts = await Department.find({});
    console.log(`\n📚 Existing Departments (${existingDepts.length}):`);
    existingDepts.forEach(dept => {
      console.log(`   - ${dept.name}`);
    });
    
    // Create wards first
    const { createdWards, wardMap } = await createWards();
    
    // Create rooms
    const { createdRooms, roomMap } = await createRooms(wardMap);
    
    // Create regular beds
    const createdBeds = await createBeds(roomMap, wardMap);
    
    // Create recovery beds for OT rooms
    const recoveryBeds = await createOperationTheaterRecoveryBeds(roomMap);
    
    // Print summary
    await printSummary(createdWards, createdRooms, createdBeds, recoveryBeds);
    
    console.log('\n💡 Next Steps:');
    console.log('   1. You can now admit patients to these beds');
    console.log('   2. Update bed charges as needed via Admin panel');
    console.log('   3. Assign nurses to specific wards');
    console.log('   4. Configure room-specific settings');
    
  } catch (error) {
    console.error('\n❌ Error creating sample data:', error);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// Run the script
if (require.main === module) {
  main();
}

module.exports = { createWards, createRooms, createBeds };