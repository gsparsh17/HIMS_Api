# Backblaze B2 setup for a hospital deployment

MediQliq HIMS can use one private B2 bucket for both media and database backups. Provider selection is controlled only by the hospital deployment environment, so the same codebase can continue using local storage, Cloudinary, Google Drive backups, or B2.

## Recommended production ownership

For production, prefer a separate B2 account for each hospital. During early rollout, separate private buckets in one company account are also supported. Each hospital deployment receives only its own bucket/application-key credentials.

The free B2 storage allowance is account-level, not per bucket, so multiple buckets in one B2 account share the same allowance.

## Create the bucket

1. Sign in to Backblaze and enable B2 Cloud Storage.
2. Create a **Private** bucket.
3. Use an opaque bucket name. Do not put patient names, UHIDs, diagnoses, phone numbers, hospital registration data, or other PHI/PII in bucket or object names.
4. Enable the bucket's default Backblaze server-side encryption (SSE-B2 / AES-256).
5. Copy the bucket ID if available.

## Create an application key

Create a key restricted to the hospital bucket. For the HIMS storage/backup features, give it these file capabilities:

- readFiles
- writeFiles
- listFiles
- deleteFiles

Set `B2_BUCKET_ID` in the hospital environment whenever possible; this lets the application use a bucket-restricted key without depending on bucket-list permissions for normal operations.

Copy the key ID and application key immediately. The application key is only shown once.

## Environment example: B2 for both media and backup

```env
MEDIA_STORAGE_PROVIDER=b2
MEDIA_STORAGE_PREFIX=media

B2_KEY_ID=...
B2_APPLICATION_KEY=...
B2_BUCKET_NAME=opaque-private-bucket-name
B2_BUCKET_ID=...
B2_API_BASE=https://api.backblazeb2.com
B2_SERVER_SIDE_ENCRYPTION=AES256

# This can be unique per hospital if several hospitals temporarily share one bucket.
B2_BACKUP_PREFIX=tenants/7f4c2a/backups/database

BACKUP_ENABLED=true
BACKUP_STORAGE_PROVIDERS=local,b2
BACKUP_REQUIRED_TARGETS=local,b2
BACKUP_TIMEZONE=Asia/Kolkata
BACKUP_INCREMENTAL_ENABLED=true
BACKUP_INCREMENTAL_CRON=15 2 * * 1-6
BACKUP_INCREMENTAL_FALLBACK_TO_FULL=false
BACKUP_FULL_ENABLED=true
BACKUP_FULL_CRON=30 2 * * 0
```

Media is stored automatically below the environment-controlled `MEDIA_STORAGE_PREFIX`, for example:

```text
media/<hospital-object-id>/<category>/<random-file-name>
```

Backups are stored below the independently controlled `B2_BACKUP_PREFIX`. This allows media and backups to share the same private bucket without sharing a namespace.

## Verify B2 before enabling it

```bash
npm run storage:b2:check
```

Then test a non-production upload, download and delete through the normal HIMS `/api/files/<id>` endpoint.

## True incremental backups require MongoDB Change Streams

For daily record-level incremental backup, the MongoDB deployment must be a replica set or sharded cluster. A single hospital MongoDB server can run as a single-node replica set.

After configuring `replication.replSetName: rs0`, restarting MongoDB and running `rs.initiate()` once, use a URI that includes the replica set, for example:

```env
MONGO_URI=mongodb://user:password@127.0.0.1:27017/hims?authSource=hims&replicaSet=rs0
```

The scheduler then journals inserts, updates, replacements and deletes. Daily incremental ZIPs contain only the latest state of changed documents plus delete tombstones. If there are no database changes, no incremental ZIP is uploaded.

## B2 lifecycle rules

Use B2 lifecycle rules for the **backup prefix only**. Do not apply aggressive backup-retention rules to the media prefix.

A practical starting recovery policy is:

- daily incremental backups: retain around 90 days;
- weekly full backups: retain 6-12 months;
- media: retain until the HIMS explicitly deletes/replaces the object or your hospital retention policy says otherwise.

The exact policy should be agreed with each hospital and adjusted for legal/regulatory requirements and available storage.
