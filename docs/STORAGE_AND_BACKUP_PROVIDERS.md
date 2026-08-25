# MediQliq HIMS storage and backup providers

This deployment keeps media storage and database backup destinations independent and controlled by environment variables.

## 1. Media storage switch

Use exactly one provider for new uploads:

```env
MEDIA_STORAGE_PROVIDER=local
# local | b2 | cloudinary
MEDIA_STORAGE_PREFIX=media
```

Existing `StoredFile` rows keep their own `storageDriver`, so changing the provider does not make old files unreadable.

### Local

```env
MEDIA_STORAGE_PROVIDER=local
UPLOAD_DIR=/srv/mediqliq/uploads
UPLOAD_TMP_DIR=/srv/mediqliq/tmp
```

### Backblaze B2

Keep the bucket private. The browser continues to receive `/api/files/<id>` URLs and the HIMS backend streams the object after its normal hospital/file authorization checks.

```env
MEDIA_STORAGE_PROVIDER=b2
B2_KEY_ID=
B2_APPLICATION_KEY=
B2_BUCKET_NAME=
B2_BUCKET_ID=
B2_API_BASE=https://api.backblazeb2.com
B2_SERVER_SIDE_ENCRYPTION=AES256
```

Recommended B2 application-key capabilities for the HIMS bucket are `readFiles`, `writeFiles`, `listFiles` and `deleteFiles`. Supplying `B2_BUCKET_ID` is recommended for a bucket-restricted key because it avoids requiring bucket-list access for normal operation.

Media object names use opaque hospital IDs/random values under `${MEDIA_STORAGE_PREFIX}/<hospital-id>/...`; do not put patient names, UHIDs, phone numbers, diagnoses or other PHI/PII in B2 bucket names, object names or custom metadata.

### Cloudinary

```env
MEDIA_STORAGE_PROVIDER=cloudinary
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

Cloudinary remains available for hospitals that already use it. B2 is recommended for private HIMS files and backups because it is general-purpose object storage; Cloudinary remains useful where image/video transformation and delivery features are the priority.

## 2. Backups are a separate switch

A hospital can back up to one or more destinations regardless of the media provider:

```env
BACKUP_STORAGE_PROVIDERS=local,b2
BACKUP_REQUIRED_TARGETS=local,b2
```

Supported targets are:

- `local`
- `b2`
- `gdrive`

Examples:

```env
# Fully local hospital
MEDIA_STORAGE_PROVIDER=local
BACKUP_STORAGE_PROVIDERS=local

# B2 media, local + B2 database recovery copies
MEDIA_STORAGE_PROVIDER=b2
BACKUP_STORAGE_PROVIDERS=local,b2

# Cloudinary media but B2 database backup
MEDIA_STORAGE_PROVIDER=cloudinary
BACKUP_STORAGE_PROVIDERS=local,b2

# Existing Google Drive backup retained as an additional copy
BACKUP_STORAGE_PROVIDERS=local,b2,gdrive
```

`BACKUP_REQUIRED_TARGETS` decides which targets must succeed before the incremental checkpoint advances. If an optional target fails, the run is recorded as `partial`; if a required target fails, the checkpoint is not advanced, so those changes are attempted again.

## 3. B2 media and backups may share one private bucket

This is supported. Both namespaces are environment-controlled. Media uses:

```env
MEDIA_STORAGE_PREFIX=media
```

which produces paths such as `media/<hospital-id>/<category>/...`. Database backup objects use:

```env
B2_BACKUP_PREFIX=backups/database
```

For multiple hospitals temporarily sharing one company bucket, set a different opaque backup prefix in each hospital deployment, for example:

```env
B2_BACKUP_PREFIX=tenants/7f4c2a/backups/database
```

Later, moving a hospital to its own B2 account/bucket only requires changing that hospital's environment credentials and bucket values.

## 4. Backup strategy: weekly full + record-level daily incremental

Default schedule:

```env
BACKUP_ENABLED=true
BACKUP_INCREMENTAL_ENABLED=true
BACKUP_INCREMENTAL_CRON=15 2 * * 1-6
BACKUP_FULL_ENABLED=true
BACKUP_FULL_CRON=30 2 * * 0
BACKUP_TIMEZONE=Asia/Kolkata
```

That means:

- Monday-Saturday 02:15: incremental backup.
- Sunday 02:30: full recovery baseline.

The incremental engine is not a whole-database re-export. A MongoDB Change Stream journals insert/update/replace/delete events. At backup time events are collapsed by collection + document ID and only the current version of changed documents plus delete tombstones are written to the incremental ZIP.

If ten records changed during the day, the incremental payload contains those changed records/tombstones rather than every unchanged record in the database.

If there are no database changes since the last successful checkpoint, the incremental run is recorded as `skipped` and no backup ZIP is uploaded.

## 5. MongoDB requirement for true incremental backup

MongoDB Change Streams require a replica set or sharded cluster. A single on-prem MongoDB server can be configured as a single-node replica set.

Typical self-managed outline (adapt paths/hostnames to the hospital server):

1. Add a replica-set name such as `rs0` to MongoDB configuration (`replication.replSetName: rs0`).
2. Restart MongoDB.
3. Connect with `mongosh` and run `rs.initiate()` once.
4. Use a replica-set-aware URI, for example:

```env
MONGO_URI=mongodb://user:password@127.0.0.1:27017/hims?authSource=hims&replicaSet=rs0
```

Keep:

```env
BACKUP_INCREMENTAL_FALLBACK_TO_FULL=false
```

so an unavailable Change Stream never silently turns the daily incremental job into another full database upload. The Sunday full job remains independent.

If you intentionally prefer safety over storage efficiency for a deployment without Change Streams, set `BACKUP_INCREMENTAL_FALLBACK_TO_FULL=true`.

## 6. Local retention and cloud lifecycle

```env
HIMS_BACKUP_DIR=/srv/mediqliq/backups
BACKUP_LOCAL_RETENTION_DAYS=30
```

Use provider-side lifecycle/retention for cloud copies. For B2, create lifecycle rules only for the backup prefix, not for the media prefix. Keep at least enough full and incremental files to reconstruct the recovery window you promise to the hospital.

A practical starting policy is:

- local recovery copies: 30 days;
- B2 incrementals: 90 days;
- weekly full baselines: 6-12 months, depending on hospital policy and available storage.

## 7. Google Drive target

Google Drive support is not removed.

```env
BACKUP_STORAGE_PROVIDERS=local,gdrive
GDRIVE_OAUTH_CREDENTIALS_PATH=./oauth-credentials.json
GDRIVE_OAUTH_TOKEN_PATH=./token.json
GDRIVE_ALLOW_INTERACTIVE_AUTH=false
GDRIVE_BACKUP_FOLDER=Hospital_Backups
```

For production, generate the OAuth token during controlled setup and keep `GDRIVE_ALLOW_INTERACTIVE_AUTH=false` on the running hospital server.

## 8. Manual commands

```bash
npm run storage:b2:check
npm run backup:incremental
npm run backup:full
```

Existing local media can be migrated later, after B2 is verified:

```bash
npm run storage:b2:migrate
```

That migration does not need to be run merely to switch new uploads to B2; old local objects remain readable because each `StoredFile` stores its own driver.

## 9. Hospital logo

Hospital Admin can upload/replace the hospital logo from the hospital profile. The logo is stored through the same selected media provider and saved as `Hospital.logo` using the protected HIMS file URL.

The configured logo is used by the sidebar and the shared clinical/report print-branding components. Server-generated consent/OT PDFs also resolve the same stored logo. If no logo is configured, the existing fallback hospital mark remains.
