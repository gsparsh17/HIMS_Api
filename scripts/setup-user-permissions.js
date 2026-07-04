/*
 * Setup user permissions based on roles.
 * 
 * Usage:
 *   node scripts/setup-user-permissions.js
 * 
 * This script will update permissions for all users based on their roles.
 * Run this after simplify-main-feature-access.js migration.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');

// ========== PERMISSION CONFIGURATION ==========
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

  // Doctor - Full clinical access
  doctor: {
    dashboard: 'manage',
    registration_opd: 'view',
    ipd: 'manage',
    pharmacy: 'view',
    laboratory: 'view',
    radiology: 'view',
    operation_theatre: 'view',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Nurse - Full nursing access
  nurse: {
    dashboard: 'manage',
    registration_opd: 'view',
    ipd: 'manage',
    pharmacy: 'view',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Pharmacy Staff - Full pharmacy access
  pharmacy: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'view',
    pharmacy: 'manage',
    billing_finance: 'view',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // HR Staff - Full HR access
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
    hr_staff: 'manage',
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

  // Store / Inventory Manager
  store: {
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

  // Receptionist / Registrar
  receptionist: {
    dashboard: 'manage',
    registration_opd: 'manage',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'view',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  registrar: {
    dashboard: 'manage',
    registration_opd: 'manage',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'view',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // OT Staff
  ot_staff: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'manage',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Equipment Manager
  equipment_manager: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'none',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'manage',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Accountant
  accountant: {
    dashboard: 'manage',
    registration_opd: 'none',
    ipd: 'view',
    pharmacy: 'view',
    billing_finance: 'manage',
    laboratory: 'none',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'manage',
    masters_settings: 'none'
  },

  // Pathology Staff
  pathology_staff: {
    dashboard: 'manage',
    registration_opd: 'view',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'manage',
    radiology: 'none',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Radiology Staff
  radiology_staff: {
    dashboard: 'manage',
    registration_opd: 'view',
    ipd: 'view',
    pharmacy: 'none',
    billing_finance: 'none',
    laboratory: 'none',
    radiology: 'manage',
    operation_theatre: 'none',
    store_inventory: 'none',
    hr_staff: 'none',
    reports: 'view',
    masters_settings: 'none'
  },

  // Demo User - Full access for demonstration
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
// Map specific users to their roles
const USER_ROLE_MAP = {
  'admin@gmail.com': 'admin',
  'superadmin@gmail.com': 'mediqliq_super_admin',
  'cardio@gmail.com': 'doctor',
  'dental@gmail.com': 'doctor',
  'neuro@gmail.com': 'doctor',
  'nurse@gmail.com': 'nurse',
  'pharmacy@gmail.com': 'pharmacy',
  'hr@gmail.com': 'hr',
  'store@gmail.com': 'store',
  'reg@gmail.com': 'receptionist',
  'otstaff@gmail.com': 'ot_staff',
  'eq@gmail.com': 'equipment_manager',
  'demo@gmail.com': 'demo',
  'fulltime@gmail.com': 'doctor',  // if fulltime is a doctor
  'naina@gmail.com': 'nurse',      // if naina is a nurse
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

// ========== MAIN SCRIPT ==========
async function setupPermissions() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is required in .env file');
    }

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    const updates = [];
    let updatedCount = 0;
    let skippedCount = 0;

    // Process users by email
    for (const [email, role] of Object.entries(USER_ROLE_MAP)) {
      const user = await User.findOne({ email: email.toLowerCase() });
      
      if (!user) {
        console.log(`⚠️ User not found: ${email}`);
        skippedCount++;
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
        // Don't override admin/superadmin if they already have manage access
        if ((role === 'admin' || role === 'mediqliq_super_admin') && 
            user.modulePermissions?.some(p => p.access === 'manage')) {
          console.log(`⏭️ Skipping ${email} (${role}) - already has full access`);
          skippedCount++;
          continue;
        }

        await User.updateOne({ _id: user._id }, { $set: updateData });
        
        updates.push({
          email,
          role,
          permissions: permissions.map(p => `${p.moduleKey}:${p.access}`).join(', ')
        });
        
        updatedCount++;
        console.log(`✅ Updated ${email} (${role})`);
      } else {
        console.log(`⏭️ No changes needed for ${email} (${role})`);
        skippedCount++;
      }
    }

    // Process any users that might have been missed (by role only)
    const allUsers = await User.find({});
    const processedEmails = new Set(Object.keys(USER_ROLE_MAP));
    
    for (const user of allUsers) {
      if (processedEmails.has(user.email)) continue;
      
      // Check if user has any permissions at all
      const hasPermissions = user.modulePermissions && user.modulePermissions.length > 0;
      
      if (!hasPermissions) {
        // Assign default permissions based on role
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
          permissions: permissions.map(p => `${p.moduleKey}:${p.access}`).join(', ')
        });
        
        updatedCount++;
        console.log(`✅ Updated ${user.email} (${user.role || 'staff'}) - auto-assigned`);
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 PERMISSION SETUP SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Updated: ${updatedCount} user(s)`);
    console.log(`⏭️ Skipped: ${skippedCount} user(s)`);
    console.log('\n📝 Updated Users:');
    
    updates.forEach(({ email, role, permissions }) => {
      console.log(`  • ${email} (${role}): ${permissions}`);
    });

    console.log('\n' + '='.repeat(60));
    console.log('✅ Permission setup completed successfully!');
    console.log('='.repeat(60));

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