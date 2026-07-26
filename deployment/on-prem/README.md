# MediQliq on-premise deployment patch

This patch is designed for a same-origin hospital deployment:

- Nginx exposes HTTPS port 443 and proxies `/api` to Node on `127.0.0.1:5000`.
- MongoDB remains on localhost or on a private database-server IP.
- New uploaded files are stored under `UPLOAD_DIR` and downloaded only through authenticated API routes.
- The systemd unit runs the backend as the restricted `mediqliq` service user.
- The backup scripts copy MongoDB and uploaded files to separately mounted backup storage.

## Apply the changed files

1. Copy the contents of the patch's `backend/` directory over the backend repository root.
2. Copy the contents of the patch's `frontend/` directory over the frontend repository root.
3. Run `npm ci` in both repositories using a supported Node.js LTS release.
4. Copy `.env.hospital.example` to `/etc/mediqliq/backend.env`, replace every placeholder, set mode `0600`, and set owner `root:mediqliq`.
5. For a one-server deployment, change `MONGO_URI` to use `127.0.0.1:27017`. For a separate database server, use its reserved private IP.
6. Build the frontend with `VITE_BACKEND_URL=/api` and copy `dist/` to `/var/www/mediqliq/`.
7. Install the systemd unit and Nginx site, then run `systemctl daemon-reload`.
8. Put a hospital-approved certificate and key under `/etc/mediqliq/tls`.
9. Mount the NAS or encrypted backup device at the path used by `BACKUP_ROOT`.
10. Test login, permissions, upload/download, restart, backup and restore before go-live.

Run `prepare-directories.sh` before starting the backend. The backup scripts require MongoDB Database Tools, `rsync`, `flock`, and access to the configured backup mount.

## Existing Cloudinary records

The patch sends **new** uploads to protected local storage. Existing database records containing Cloudinary URLs remain readable while internet access and the Cloudinary account are available. A hospital migrating an existing production database to fully offline operation must perform a separate, verified one-time media migration before go-live. Do not delete the Cloudinary account until every legacy file has been copied and validated.
