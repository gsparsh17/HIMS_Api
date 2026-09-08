# MediQliq LAN shared media + single-node database backup (opt-in)

This deployment mode is **explicitly opt-in**. It is enabled only when:

```env
LAN_DEPLOYMENT_ENABLED=true
```

If that variable is missing or false, the backend keeps the existing cloud/server storage and backup behavior. `NODE_ROLE`, `HIMS_SHARED_STORAGE_ROOT`, `BACKUP_NODE_ENABLED`, `BACKUP_SCHEDULER_ENABLED`, startup catch-up and the distributed backup lock are not used to alter the legacy cloud flow.

## Recommended topology

```text
Windows server / main PC (example 192.168.1.52)
  Node HIMS backend
  MongoDB
  E:\MediQliqMedia
    media\...       permanent patient/staff/hospital files
    backups\...     database backup ZIP files
    temp\...        upload staging / health-check probes

Electron/browser workstations
  -> HIMS API
  -> same MongoDB
  -> same media through /api/files/<StoredFileId>
```

The browser/Electron renderer should not save or read clinical media using an SMB path. The backend remains the authorization boundary and streams stored files through `/api/files/<id>`.

## Cloud deployments

Do not add `LAN_DEPLOYMENT_ENABLED=true` to existing cloud hospitals. Keep their existing `.env` values unchanged. In particular, do not copy the Windows `E:/MediQliqMedia` paths into cloud environments.

The common production codebase can therefore serve both deployment types:

```text
LAN_DEPLOYMENT_ENABLED missing/false -> existing cloud behavior
LAN_DEPLOYMENT_ENABLED=true          -> LAN server/client safeguards enabled
```

The frontend behaves the same way. Existing cloud builds keep `VITE_BACKEND_URL=/api` and do not set `VITE_LAN_DEPLOYMENT_ENABLED`. Electron/LAN builds set `VITE_LAN_DEPLOYMENT_ENABLED=true`.

## LAN server environment

Use `.env.lan-server.example` as the reference. Important values:

```env
LAN_DEPLOYMENT_ENABLED=true
NODE_ROLE=SERVER
INSTANCE_ID=MEDIQLIQ-SERVER-01
HOST=0.0.0.0

HIMS_SHARED_STORAGE_ROOT=E:/MediQliqMedia
MEDIA_STORAGE_PROVIDER=local
MEDIA_STORAGE_PREFIX=media
UPLOAD_DIR=E:/MediQliqMedia
UPLOAD_TMP_DIR=E:/MediQliqMedia/temp

BACKUP_ENABLED=true
BACKUP_NODE_ENABLED=true
BACKUP_SCHEDULER_ENABLED=true
BACKUP_STORAGE_PROVIDERS=local
BACKUP_REQUIRED_TARGETS=local
HIMS_BACKUP_DIR=E:/MediQliqMedia/backups

BACKUP_INCREMENTAL_ENABLED=false
BACKUP_FULL_ENABLED=true
BACKUP_FULL_CRON=0 2 * * *
BACKUP_TIMEZONE=Asia/Kolkata

BACKUP_STARTUP_CATCHUP_ENABLED=true
BACKUP_STARTUP_CATCHUP_TYPE=full
BACKUP_STARTUP_CATCHUP_AFTER=02:15

BACKUP_COORDINATOR_LOCK_ENABLED=true
BACKUP_LOCK_LEASE_MS=1800000
BACKUP_LOCK_HEARTBEAT_MS=60000
```

Daily full backup is the conservative LAN default because it works with a standalone MongoDB server and does not require Change Streams. The existing incremental engine remains available if the deployment uses a replica set.

## Electron/client backend environment

Preferred architecture: Electron clients call the central backend and do not start their own backend process.

If each Electron workstation does start a local Node backend, set:

```env
LAN_DEPLOYMENT_ENABLED=true
NODE_ROLE=CLIENT
BACKUP_NODE_ENABLED=false
BACKUP_SCHEDULER_ENABLED=false
```

If that workstation-local backend processes uploads, it can use the SMB share:

```env
MEDIA_STORAGE_PROVIDER=local
UPLOAD_DIR=//192.168.1.52/MediQliqMedia
```

The Windows account running Electron/Node must have SMB read/write permission.

## Why duplicate backups are prevented

LAN mode has three safeguards:

1. `NODE_ROLE` + `BACKUP_NODE_ENABLED`: normal configuration permits backup execution only on the designated server.
2. `BACKUP_SCHEDULER_ENABLED`: cron jobs do not start on client nodes.
3. MongoDB distributed lease: even if two machines are accidentally enabled as backup nodes, only one can own the backup execution lock at a time.

Scheduled LAN backups also use a date/type schedule key. A successful daily schedule is not repeated after a process restart. Startup catch-up can create today's missing backup if the server was offline at the scheduled time.

These safeguards are not injected into cloud behavior unless `LAN_DEPLOYMENT_ENABLED=true` is explicitly enabled.

## Media write safety

In LAN mode, local/shared-drive media and local backup copies use a temporary partial file and rename it into the final name only after the copy is complete and flushed. Outside LAN mode, the existing cloud/local file-copy behavior is preserved.

## Server-side storage test

In an Electron/LAN frontend build, Admin -> Settings -> Storage & Backup provides **Test Shared Storage**. The backend process performs write/read/delete probes against:

- the configured media root, and
- the backup directory on the designated backup node.

This verifies the permissions of the account actually running the backend service.

## Important recovery note

`E:\MediQliqMedia\media` is the live media store. The daily database ZIP contains database data and StoredFile metadata, not another copy of every image/PDF. Keeping media and DB backups on the same physical drive is supported for this setup, but it does not protect against complete failure of that physical drive. A later NAS/USB/second-disk copy can be added without changing ERP file URLs.
