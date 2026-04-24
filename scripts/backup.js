const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');

// Load environment variables
require('dotenv').config();

// Dynamically import all models
const Admin = require('../models/Admin');
const Appointment = require('../models/Appointment');
const Bill = require('../models/Bill');
const BillItem = require('../models/BillItem');
const Calendar = require('../models/Calendar');
const Customer = require('../models/Customer');
const Department = require('../models/Department');
const Doctor = require('../models/Doctor');
const Episode = require('../models/Episode');
const Expense = require('../models/Expense');
const Hospital = require('../models/Hospital');
const HospitalCharges = require('../models/HospitalCharges');
const HospitalGroup = require('../models/HospitalGroup');
const ICD11 = require('../models/icd11.model');
const Invoice = require('../models/Invoice');
const IssuedMedicine = require('../models/IssuedMedicine');
const LabReport = require('../models/LabReport');
const LabTest = require('../models/LabTest');
const License = require('../models/License');
const Medicine = require('../models/Medicine');
const MedicineBatch = require('../models/MedicineBatch');
const NLEMMedicine = require('../models/NLEMMedicine');
const Nurse = require('../models/Nurse');
const OfflineSyncLog = require('../models/OfflineSyncLog');
const PathologyStaff = require('../models/PathologyStaff');
const Patient = require('../models/Patient');
const Pharmacy = require('../models/Pharmacy');
const PharmacyInvoice = require('../models/pharmacyInvoiceModel');
const Prescription = require('../models/Prescription');
const PrescriptionItem = require('../models/PrescriptionItem');
const Procedure = require('../models/Procedure');
const PurchaseOrder = require('../models/PurchaseOrder');
const Room = require('../models/Room');
const Salary = require('../models/Salary');
const Sale = require('../models/Sale');
const Shift = require('../models/Shift');
const Staff = require('../models/Staff');
const StockAdjustment = require('../models/StockAdjustment');
const Supplier = require('../models/Supplier');
const User = require('../models/User');
const Vital = require('../models/Vital');

// Map of all models with their collection names
const MODELS = [
    { name: 'Admin', model: Admin },
    { name: 'Appointment', model: Appointment },
    { name: 'Bill', model: Bill },
    { name: 'BillItem', model: BillItem },
    { name: 'Calendar', model: Calendar },
    { name: 'Customer', model: Customer },
    { name: 'Department', model: Department },
    { name: 'Doctor', model: Doctor },
    { name: 'Episode', model: Episode },
    { name: 'Expense', model: Expense },
    { name: 'Hospital', model: Hospital },
    { name: 'HospitalCharges', model: HospitalCharges },
    { name: 'HospitalGroup', model: HospitalGroup },
    { name: 'ICD11', model: ICD11 },
    { name: 'Invoice', model: Invoice },
    { name: 'IssuedMedicine', model: IssuedMedicine },
    { name: 'LabReport', model: LabReport },
    { name: 'LabTest', model: LabTest },
    { name: 'License', model: License },
    { name: 'Medicine', model: Medicine },
    { name: 'MedicineBatch', model: MedicineBatch },
    { name: 'NLEMMedicine', model: NLEMMedicine },
    { name: 'Nurse', model: Nurse },
    { name: 'OfflineSyncLog', model: OfflineSyncLog },
    { name: 'PathologyStaff', model: PathologyStaff },
    { name: 'Patient', model: Patient },
    { name: 'Pharmacy', model: Pharmacy },
    { name: 'PharmacyInvoice', model: PharmacyInvoice },
    { name: 'Prescription', model: Prescription },
    { name: 'PrescriptionItem', model: PrescriptionItem },
    { name: 'Procedure', model: Procedure },
    { name: 'PurchaseOrder', model: PurchaseOrder },
    { name: 'Room', model: Room },
    { name: 'Salary', model: Salary },
    { name: 'Sale', model: Sale },
    { name: 'Shift', model: Shift },
    { name: 'Staff', model: Staff },
    { name: 'StockAdjustment', model: StockAdjustment },
    { name: 'Supplier', model: Supplier },
    { name: 'User', model: User },
    { name: 'Vital', model: Vital }
];

// Configuration
const BACKUP_DIR = 'D:\\backups\\hospital_backups';
const TEMP_DIR = path.join(BACKUP_DIR, 'temp');
const HOSPITAL_NAME = process.env.HOSPITAL_NAME || 'City_Hospital';

const CREDENTIALS_PATH = path.join(__dirname, '../oauth-credentials.json');
const TOKEN_PATH = path.join(__dirname, '../token.json');

async function getOAuthClient() {
    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));

        const { client_id, client_secret, redirect_uris } = credentials.installed;

        const client = new google.auth.OAuth2(
            client_id,
            client_secret,
            redirect_uris[0]
        );

        client.setCredentials(token);
        return client;
    }

    const auth = await authenticate({
        keyfilePath: CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(auth.credentials));
    return auth;
}

// Ensure directories exist
[BACKUP_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Get timestamp for filename
function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    return `${year}${month}${day}_${hour}${minute}`;
}

// Escape CSV field
function escapeCSVField(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (value instanceof mongoose.Types.ObjectId) {
        return value.toString();
    }

    const stringValue = String(value);

    // If contains comma, newline, or double quote, wrap in quotes and escape existing quotes
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n') || stringValue.includes('\r')) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
}

// Flatten object for CSV (handle nested objects)
function flattenObject(obj, prefix = '') {
    const flattened = {};

    if (!obj || typeof obj !== 'object') return flattened;

    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;

        const value = obj[key];
        const newKey = prefix ? `${prefix}.${key}` : key;

        if (value === null || value === undefined) {
            flattened[newKey] = '';
        } else if (value instanceof Date) {
            flattened[newKey] = value.toISOString();
        } else if (value instanceof mongoose.Types.ObjectId) {
            flattened[newKey] = value.toString();
        } else if (Array.isArray(value)) {
            // For arrays, convert to JSON string
            flattened[newKey] = JSON.stringify(value);
        } else if (typeof value === 'object') {
            // Check if it's a populated document with _id
            if (value._id) {
                flattened[newKey] = value._id.toString();
                // Add display name if available
                if (value.first_name || value.firstName) {
                    flattened[`${newKey}_name`] = `${value.first_name || value.firstName || ''} ${value.last_name || value.lastName || ''}`.trim();
                }
            } else if (value.constructor && value.constructor.name === 'Object') {
                // Recursively flatten plain objects
                Object.assign(flattened, flattenObject(value, newKey));
            } else {
                flattened[newKey] = JSON.stringify(value);
            }
        } else {
            flattened[newKey] = value;
        }
    }

    return flattened;
}

// Export a single collection to CSV
async function exportCollection(modelInfo) {
    const { name, model } = modelInfo;
    const collectionName = model.collection ? model.collection.collectionName : name.toLowerCase();

    try {
        console.log(`  📊 Exporting ${name} (${collectionName})...`);

        // Get all documents
        const documents = await model.find().lean();

        if (documents.length === 0) {
            console.log(`    ⚠️ No documents found`);
            return null;
        }

        // Flatten all documents
        const flattenedDocs = documents.map(doc => flattenObject(doc));

        // Get all unique field names from all documents
        const allFields = new Set();
        flattenedDocs.forEach(doc => {
            Object.keys(doc).forEach(key => allFields.add(key));
        });

        // Exclude sensitive fields
        const excludeFields = ['password', 'resetToken', 'refreshToken', 'privateKey', 'secret'];
        const fields = Array.from(allFields).filter(field => !excludeFields.includes(field));

        // Create CSV content
        const csvRows = [];
        csvRows.push(fields.map(f => escapeCSVField(f)).join(','));

        for (const doc of flattenedDocs) {
            const row = fields.map(field => {
                let value = doc[field];
                if (value === undefined) value = '';
                return escapeCSVField(value);
            });
            csvRows.push(row.join(','));
        }

        // Write to file
        const filePath = path.join(TEMP_DIR, `${collectionName}.csv`);
        fs.writeFileSync(filePath, csvRows.join('\n'), 'utf8');

        console.log(`    ✓ Exported ${documents.length} records, ${fields.length} fields`);
        return { filePath, collectionName, recordCount: documents.length };
    } catch (error) {
        console.error(`    ✗ Error exporting ${name}:`, error.message);
        return null;
    }
}

// Create metadata file with backup information
function createMetadataFile(timestamp, exportedCollections) {
    const metadata = {
        backup_date: new Date().toISOString(),
        hospital_name: HOSPITAL_NAME,
        backup_timestamp: timestamp,
        collections_exported: exportedCollections.map(c => ({
            name: c.collectionName,
            records: c.recordCount
        })),
        total_collections: exportedCollections.length,
        total_records: exportedCollections.reduce((sum, c) => sum + c.recordCount, 0),
        mongodb_version: mongoose.version,
        node_version: process.version,
        environment: process.env.NODE_ENV || 'production'
    };

    const metadataPath = path.join(TEMP_DIR, `backup_metadata.json`);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(`  ✓ Created metadata file`);
    return metadataPath;
}

// Create ZIP archive of all CSV files
async function createZipArchive(timestamp, exportedFiles) {
    return new Promise((resolve, reject) => {
        const zipFileName = `${HOSPITAL_NAME}_complete_backup_${timestamp}.zip`;
        const zipFilePath = path.join(BACKUP_DIR, zipFileName);

        const output = fs.createWriteStream(zipFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
            console.log(`  📦 Created ZIP: ${zipFileName} (${sizeMB} MB)`);
            resolve(zipFilePath);
        });

        archive.on('error', reject);
        archive.pipe(output);

        // Add all exported CSV files
        for (const file of exportedFiles) {
            if (file && fs.existsSync(file)) {
                archive.file(file, { name: path.basename(file) });
            }
        }

        archive.finalize();
    });
}

async function uploadToGoogleDrive(filePath, hospitalName, timestamp) {
    try {
        console.log(`\n☁️ Uploading to Google Drive (OAuth)...`);

        const auth = await getOAuthClient();

        const drive = google.drive({
            version: 'v3',
            auth
        });

        // ===============================
        // Step 1: Create / Get Hospital Folder
        // ===============================
        let hospitalFolderId;

        const hospitalQuery = `name='${hospitalName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;

        const hospitalRes = await drive.files.list({
            q: hospitalQuery,
            fields: 'files(id, name)'
        });

        if (hospitalRes.data.files.length > 0) {
            hospitalFolderId = hospitalRes.data.files[0].id;
            console.log(`  ✓ Using existing hospital folder`);
        } else {
            const folder = await drive.files.create({
                resource: {
                    name: hospitalName,
                    mimeType: 'application/vnd.google-apps.folder'
                },
                fields: 'id'
            });

            hospitalFolderId = folder.data.id;
            console.log(`  ✓ Created hospital folder`);
        }

        // ===============================
        // Step 2: Year Folder
        // ===============================
        const year = new Date().getFullYear().toString();

        let yearFolderId;

        const yearRes = await drive.files.list({
            q: `name='${year}' and '${hospitalFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
            fields: 'files(id)'
        });

        if (yearRes.data.files.length > 0) {
            yearFolderId = yearRes.data.files[0].id;
        } else {
            const folder = await drive.files.create({
                resource: {
                    name: year,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [hospitalFolderId]
                },
                fields: 'id'
            });

            yearFolderId = folder.data.id;
            console.log(`  ✓ Created year folder`);
        }

        // ===============================
        // Step 3: Month Folder
        // ===============================
        const month = String(new Date().getMonth() + 1).padStart(2, '0');
        const yearMonth = `${year}-${month}`;

        let monthFolderId;

        const monthRes = await drive.files.list({
            q: `name='${yearMonth}' and '${yearFolderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
            fields: 'files(id)'
        });

        if (monthRes.data.files.length > 0) {
            monthFolderId = monthRes.data.files[0].id;
            console.log(`  ✓ Using existing month folder`);
        } else {
            const folder = await drive.files.create({
                resource: {
                    name: yearMonth,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [yearFolderId]
                },
                fields: 'id'
            });

            monthFolderId = folder.data.id;
            console.log(`  ✓ Created month folder`);
        }

        // ===============================
        // Step 4: Upload File
        // ===============================
        const fileName = path.basename(filePath);
        const fileSizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);

        const response = await drive.files.create({
            resource: {
                name: fileName,
                parents: [monthFolderId]
            },
            media: {
                mimeType: 'application/zip',
                body: fs.createReadStream(filePath)
            },
            fields: 'id, webViewLink'
        });

        console.log(`  ✅ Uploaded: ${fileName} (${fileSizeMB} MB)`);
        console.log(`  🔗 ${response.data.webViewLink}`);

        return true;

    } catch (error) {
        console.error(`  ❌ Upload failed:`, error.message);
        return false;
    }
}

// Main backup function
async function performBackup() {
    const timestamp = getTimestamp();
    const exportedResults = [];
    const exportedFiles = [];

    console.log('\n' + '='.repeat(70));
    console.log(`🔄 STARTING COMPLETE DATABASE BACKUP`);
    console.log('='.repeat(70));
    console.log(`🏥 Hospital: ${HOSPITAL_NAME}`);
    console.log(`📅 Date/Time: ${new Date().toLocaleString()}`);
    console.log(`📁 Backup Directory: ${BACKUP_DIR}`);
    console.log('');

    try {
        // Export each collection
        console.log(`📚 Exporting ${MODELS.length} collections:\n`);

        for (const modelInfo of MODELS) {
            const result = await exportCollection(modelInfo);
            if (result) {
                exportedResults.push(result);
                exportedFiles.push(result.filePath);
            }
        }

        console.log(`\n✅ Successfully exported ${exportedResults.length} out of ${MODELS.length} collections`);
        console.log(`📊 Total records exported: ${exportedResults.reduce((sum, r) => sum + r.recordCount, 0).toLocaleString()}\n`);

        // Create metadata file
        console.log(`📝 Creating backup metadata...`);
        const metadataPath = createMetadataFile(timestamp, exportedResults);
        exportedFiles.push(metadataPath);

        // Create ZIP archive
        console.log(`\n📦 Creating ZIP archive...`);
        const zipFilePath = await createZipArchive(timestamp, exportedFiles);

        // Upload to Google Drive
        const uploadSuccess = await uploadToGoogleDrive(zipFilePath, HOSPITAL_NAME, timestamp);

        // Clean up temp files
        console.log(`\n🧹 Cleaning up temporary files...`);
        for (const file of exportedFiles) {
            if (fs.existsSync(file) && file !== zipFilePath) {
                fs.unlinkSync(file);
            }
        }

        // Clean old backups (keep only last 6 months)
        // cleanOldBackups();

        // Final summary
        console.log('\n' + '='.repeat(70));
        console.log(`✅ BACKUP COMPLETED SUCCESSFULLY!`);
        console.log('='.repeat(70));
        console.log(`📁 Local backup: ${zipFilePath}`);
        console.log(`☁️ Cloud backup: ${uploadSuccess ? 'Uploaded to Google Drive' : 'Upload failed'}`);
        console.log(`📊 Collections backed up: ${exportedResults.length}`);
        console.log(`📝 Total records: ${exportedResults.reduce((sum, r) => sum + r.recordCount, 0).toLocaleString()}`);
        console.log('='.repeat(70) + '\n');

        return { success: true, zipFilePath, uploadSuccess, exportedResults };
    } catch (error) {
        console.error('\n❌ BACKUP FAILED:', error.message);
        console.error(error.stack);
        return { success: false, error: error.message };
    }
}

// Run backup if called directly
if (require.main === module) {
    // Connect to MongoDB
    mongoose.connect(process.env.MONGO_URI)
        .then(async () => {
            console.log('✅ Connected to MongoDB Atlas');
            await performBackup();
            await mongoose.disconnect();
            console.log('👋 Disconnected from MongoDB');
            process.exit(0);
        })
        .catch(err => {
            console.error('❌ MongoDB connection error:', err);
            process.exit(1);
        });
}

module.exports = { performBackup };