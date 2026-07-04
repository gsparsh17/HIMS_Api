/*
 * FINAL: Setup user permissions based on roles.
 * This is the definitive permission setup script.
 * Covers ALL sidebar items for ALL roles.
 * 
 * Usage:
 *   node scripts/final-setup-user-permissions.js
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');

// ========== PERMISSION CONFIGURATION ==========
// All 12 main features
const MAIN_FEATURES = [
  'dashboard',
  'registration_opd',
  'ipd',
  'pharmacy',
  'billing_finance',
  'laboratory',
  'radiology',
  'operation_theatre',
  'store_inventory',
  'hr_staff',
  'reports',
  'masters_settings'
];

// ========== ROLE PERMISSIONS ==========
// These map to what each role should see in their sidebar
const ROLE_PERMISSIONS = {
  // Admin - Full access to everything
  admin: {
    dashboard: 'manage',
    registration_opd: 'manage',
    ipd: 'manage',
    pharmacy: 'manage',
    billing_finance: 'manage',
    laboratory: 'manage',
    radiology: 'manage',
    operation_theatre: 'manage',
    store_inventory: 'manage',
    hr_staff: 'manage',
    reports: 'manage',
    masters_settings: 'manage'
  },

  // Super Admin - Full access to everything
  mediqliq_super_admin: {
    dashboard: 'manage',
    registration_opd: 'manage',
    ipd: 'manage',
    pharmacy: 'manage',
    billing_finance: 'manage',
    laboratory: 'manage',
    radiology: 'manage',
    operation_theatre: 'manage',
    store_inventory: 'manage',
    hr_staff: 'manage',
    reports: 'manage',
    masters_settings: 'manage'
  },

  // Demo - Full access to everything
  demo: {
    dashboard: 'manage',
    registration_opd: 'manage',
    ipd: 'manage',
    pharmacy: 'manage',
    billing_finance: 'manage',
    laboratory: 'manage',
    radiology: 'manage',
    operation_theatre: 'manage',
    store_inventory: 'manage',
    hr_staff: 'manage',
    reports: 'manage',
    masters_settings: 'manage'
  },

  // Doctor - Sees all doctor sidebar items
  doctor: {
    dashboard: 'manage',
    registration_opd: 'manage',    // Appointments, Schedule, My Patients
    ipd: 'manage',                  // IPD Patients
    pharmacy: 'view',               // For viewing medicines
    billing_finance: 'view',        // Fees & Collections
    laboratory: 'view',             // Reports & Tests
    radiology: 'view',              // Radiology Orders
    operation_theatre: 'view',      // My OT Requests
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Nurse - Sees all nurse sidebar items
  nurse: {
    dashboard: 'manage',
    registration_opd: 'manage',    // OPD Vitals, Patient List
    ipd: 'manage',                  // IPD Ward, Nursing Notes, Shift Handover
    pharmacy: 'view',
    billing_finance: 'none',
    laboratory: 'view',             // Lab Tests
    radiology: 'view',              // Radiology
    operation_theatre: 'view',      // OT Assignments
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Pharmacy - Sees all pharmacy sidebar items
  pharmacy: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'view',                    // IPD Patients
    pharmacy: 'manage',             // Full pharmacy access
    billing_finance: 'manage',      // Billing, Payments, Outstanding
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'manage',              // Sales Reports, Profit & Loss, Doctor Commission
    masters_settings: 'manage'      // Settings, Tax Configuration, User Management
  },

  // HR - Sees all HR sidebar items
  hr: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'none',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'manage',             // Full HR access
    reports: 'view',
    masters_settings: 'none'
  },

  hr_manager: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'none',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'manage',
    reports: 'view',
    masters_settings: 'none'
  },

  // Store - Sees all store sidebar items
  store: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'none',
    pharmacy: 'view',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'manage',      // Full store access
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  store_manager: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'none',
    pharmacy: 'view',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'manage',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  inventory_manager: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'none',
    pharmacy: 'view',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'manage',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Receptionist/Registrar - Sees all staff sidebar items
  receptionist: {
    dashboard: 'manage',
    registration_opd: 'manage',     // Appointments, Patients, Guide
    ipd: 'manage',                  // IPD Management, Discharges
    pharmacy: 'view',
    billing_finance: 'manage',      // Billing, IPD Financial Billing
    laboratory: 'view',             // Lab Tests
    radiology: 'view',              // Radiology
    operation_theatre: 'view',      // Procedures, OT Management
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  registrar: {
    dashboard: 'manage',
    registration_opd: 'manage',
    ipd: 'manage',
    pharmacy: 'view',
    billing_finance: 'manage',
    laboratory: 'view',
    radiology: 'view',
    operation_theatre: 'view',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // OT Staff - Sees all OT sidebar items
  ot_staff: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'view',                    // IPD Patients
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'manage',    // Full OT access
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Equipment Manager - Sees equipment/store sidebar items
  equipment_manager: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'none',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'manage',      // Full store access
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Accountant - Sees finance sidebar items
  accountant: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'view',
    pharmacy: 'view',
    billing_finance: 'manage',      // Full finance access
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'manage',              // Full reports access
    masters_settings: 'none'
  },

  // Pathology Staff - Sees lab sidebar items
  pathology_staff: {
    dashboard: 'manage',
    registration_opd: 'view',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'manage',           // Full lab access
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Radiology Staff - Sees radiology sidebar items
  radiology_staff: {
    dashboard: 'manage',
    registration_opd: 'view',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'manage',            // Full radiology access
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Staff - Basic access
  staff: {
    dashboard: 'manage',
    registration_opd: 'view',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  }
};

// ========== USER TO ROLE MAPPING ==========
const USER_ROLE_MAP = {
  // Admins
  'admin@gmail.com': 'admin',
  'superadmin@gmail.com': 'mediqliq_super_admin',
  
  // Doctors
  'cardio@gmail.com': 'doctor',
  'dental@gmail.com': 'doctor',
  'neuro@gmail.com': 'doctor',
  'fulltime@gmail.com': 'doctor',
  
  // Nurses
  'nurse@gmail.com': 'nurse',
  'naina@gmail.com': 'nurse',
  
  // Pharmacy
  'pharmacy@gmail.com': 'pharmacy',
  
  // HR
  'hr@gmail.com': 'hr',
  
  // Store
  'store@gmail.com': 'store',
  
  // Receptionist/Registrar
  'reg@gmail.com': 'receptionist',
  
  // OT Staff
  'otstaff@gmail.com': 'ot_staff',
  
  // Equipment Manager
  'eq@gmail.com': 'equipment_manager',
  
  // Demo - FULL ACCESS
  'demo@gmail.com': 'demo',
};

// ========== HELPER FUNCTIONS ==========
function buildPermissions(role) {
  const permissions = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.staff;
  
  return Object.entries(permissions).map(([moduleKey, access]) => ({
    moduleKey,
    access,
    grantedBy: null,
    grantedAt: new Date(),
    updatedAt: new Date()
  }));
}

function buildDashboardAccess(permissions) {
  return permissions
    .filter(p => p.access !== 'none')
    .map(p => p.moduleKey);
}

function getPermissionSummary(permissions) {
  return permissions
    .filter(p => p.access !== 'none')
    .map(p => `${p.moduleKey}:${p.access}`)
    .join(', ') || 'none';
}

// ========== MAIN SCRIPT ==========
async function setupPermissions() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is required in .env file');
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');
    console.log('='.repeat(70));
    console.log('📋 FINAL USER PERMISSION SETUP');
    console.log('='.repeat(70));
    console.log('\n📌 This will update permissions for ALL users based on their roles.\n');

    const updates = [];
    let updatedCount = 0;
    let skippedCount = 0;
    let notFoundCount = 0;

    // Process users by email
    for (const [email, role] of Object.entries(USER_ROLE_MAP)) {
      const user = await User.findOne({ email: email.toLowerCase() });
      
      if (!user) {
        console.log(`❌ User not found: ${email}`);
        notFoundCount++;
        continue;
      }

      const permissions = buildPermissions(role);
      const dashboardAccess = buildDashboardAccess(permissions);

      // Build update object
      const updateData = {
        modulePermissions: permissions,
        dashboard_access: dashboardAccess
      };

      // Check if permissions actually changed
      const currentPermissions = (user.modulePermissions || []).map(p => ({
        moduleKey: p.moduleKey,
        access: p.access
      }));

      const newPermissions = permissions.map(p => ({
        moduleKey: p.moduleKey,
        access: p.access
      }));

      const changed = JSON.stringify(currentPermissions) !== JSON.stringify(newPermissions);

      if (changed) {
        await User.updateOne({ _id: user._id }, { $set: updateData });
        
        updates.push({
          email,
          role,
          permissions: getPermissionSummary(permissions)
        });
        
        updatedCount++;
        console.log(`✅ ${email} (${role}) → ${getPermissionSummary(permissions)}`);
      } else {
        console.log(`⏭️ ${email} (${role}) → No changes needed`);
        skippedCount++;
      }
    }

    // Process any users that were not in the map
    const allUsers = await User.find({});
    const processedEmails = new Set(Object.keys(USER_ROLE_MAP));
    
    for (const user of allUsers) {
      if (processedEmails.has(user.email)) continue;
      
      // Skip if user already has permissions
      const hasPermissions = user.modulePermissions && user.modulePermissions.length > 0;
      
      if (!hasPermissions) {
        const role = user.role || 'staff';
        const permissions = buildPermissions(role);
        const dashboardAccess = buildDashboardAccess(permissions);
        
        await User.updateOne(
          { _id: user._id },
          { 
            $set: { 
              modulePermissions: permissions,
              dashboard_access: dashboardAccess
            } 
          }
        );
        
        updates.push({
          email: user.email,
          role: user.role || 'staff',
          permissions: getPermissionSummary(permissions)
        });
        
        updatedCount++;
        console.log(`✅ ${user.email} (${user.role || 'staff'}) → ${getPermissionSummary(permissions)} (auto-assigned)`);
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 PERMISSION SETUP SUMMARY');
    console.log('='.repeat(70));
    console.log(`✅ Updated: ${updatedCount} user(s)`);
    console.log(`⏭️ Skipped (no changes): ${skippedCount} user(s)`);
    console.log(`❌ Not found: ${notFoundCount} user(s)`);
    
    if (updates.length > 0) {
      console.log('\n📝 Updated Users:');
      updates.forEach(({ email, role, permissions }) => {
        console.log(`  • ${email} (${role}): ${permissions}`);
      });
    }

    // ========== VERIFICATION ==========
    console.log('\n' + '='.repeat(70));
    console.log('🔍 VERIFICATION - Check specific users');
    console.log('='.repeat(70));
    
    const verifyEmails = [
      'reg@gmail.com',
      'demo@gmail.com', 
      'admin@gmail.com',
      'pharmacy@gmail.com',
      'nurse@gmail.com',
      'cardio@gmail.com',
      'hr@gmail.com',
      'store@gmail.com',
      'otstaff@gmail.com',
      'eq@gmail.com'
    ];
    
    for (const email of verifyEmails) {
      const user = await User.findOne({ email: email.toLowerCase() });
      if (user) {
        const perms = getPermissionSummary(user.modulePermissions || []);
        console.log(`  ${email}: ${perms}`);
      } else {
        console.log(`  ${email}: NOT FOUND`);
      }
    }

    // ========== WHAT EACH ROLE WILL SEE ==========
    console.log('\n' + '='.repeat(70));
    console.log('📋 WHAT EACH ROLE WILL SEE');
    console.log('='.repeat(70));
    console.log(`
  👑 Admin / Super Admin: Everything
  👨‍⚕️ Doctor: Dashboard, Appointments, Schedule, IPD Patients, My Patients, 
             Department, Reports & Tests, Radiology Orders, Fees, OT Requests, Profile
  👩‍⚕️ Nurse: Dashboard, OPD Vitals, Pending Assessments, Patient List, IPD Ward, 
             Lab Tests, Radiology, OT Assignments, Profile
  💊 Pharmacy: Dashboard, Inventory, Purchasing, Sales, Prescriptions, IPD Patients,
               Billing, Reports, Profile, Settings
  🏥 Receptionist: Dashboard, Guide, Appointments, Patients, IPD Management,
                   Procedures, Lab Tests, Radiology, OT Management, Billing, 
                   Discharges, Profile
  👔 HR: Dashboard, HR Dashboard, Employees, Attendance, Availability, 
         Leave Requests, Payroll, Profile
  📦 Store: Dashboard, Store Dashboard, Items, Categories, Requisitions, Issues,
            Purchase Orders, Low Stock, Maintenance, Profile
  🏗️ OT Staff: Dashboard, OT Dashboard, OT Requests, OT Schedule, IPD Patients, Profile
  🔧 Equipment Manager: Dashboard, Store Dashboard, Items, Maintenance Logs, Profile
  🎯 Demo: Everything (Full Access)
`);

    console.log('\n' + '='.repeat(70));
    console.log('✅ Permission setup completed successfully!');
    console.log('='.repeat(70));

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// Run the script
setupPermissions();