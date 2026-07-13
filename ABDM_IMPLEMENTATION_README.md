# MediQliq ABDM Integration – Deployment and Implementation Guide

This backend now supports the deployment architecture used by MediQliq:

- **One central ABDM Master** with one MediQliq bridge/client credential set and a master control-plane MongoDB.
- **One separate ERP backend + separate MongoDB per hospital/clinic**.
- The central master stores facility routing, callback correlation, consent metadata, retry jobs and integration audit metadata. It does **not** become the clinical database.
- Each hospital remains the source of truth for patients, appointments, admissions, prescriptions, reports, invoices and other clinical records.

## 1. Deployment roles

### Central master

```env
APP_ROLE=ABDM_MASTER
```

Mounts:

- `POST /api/v3/...` – public ABDM V3 callbacks.
- `/internal/abdm/...` – HMAC-authenticated requests from hospital deployments.
- `/api/abdm/master/...` – MediQliq master administration endpoints protected by `X-Master-Admin-Key`.

Use `.env.master.example` as the starting point.

### Hospital deployment

```env
APP_ROLE=HOSPITAL
```

Runs the existing hospital ERP and additionally mounts:

- `/api/abha/...` – authenticated M1 ABHA user workflows.
- `/api/abdm/...` – authenticated hospital-user care-context/FHIR operations.
- `/internal/abdm/...` – private HMAC-authenticated callbacks from the MediQliq ABDM Master.

Use `.env.hospital.example` as the starting point.

## 2. First-time master setup

1. Deploy the master at a stable public HTTPS URL such as `https://api.mediqliq.com`.
2. Use a dedicated MongoDB database, for example `mediqliq_abdm_master`.
3. Rotate any credentials that have previously been exposed and configure the rotated sandbox client credentials.
4. Generate long random values for:
   - `ABDM_MASTER_ADMIN_KEY`
   - `ABDM_MASTER_ENCRYPTION_KEY`
5. Validate the configuration:

```bash
npm run abdm:validate
```

6. Verify V3 gateway authentication and update the bridge callback URL:

```bash
npm run abdm:bridge
```

The bridge bootstrap intentionally does **not** call the legacy V1 `addUpdateServices` API.

## 3. External NHPR/HFR steps required for every hospital

The ERP cannot invent an ABDM Facility ID.

For each hospital/clinic:

1. Check whether the facility already has an NHPR/HFR Facility ID.
2. If not, the authorized facility manager must complete facility registration and approval in NHPR/HFR.
3. Obtain the real Facility ID (for example an `IN...` identifier).
4. Complete **Software Linkage** in NHPR/HFR and link the facility to the MediQliq Bridge ID.
5. Register the facility/software relationship for the HIP role.
6. Configure Scan & Share counters/QR where required.
7. Register the facility in the MediQliq ABDM Master as shown below.

## 4. Register a hospital in the MediQliq master

Example request:

```bash
curl -X POST "https://api.mediqliq.com/api/abdm/master/facilities" \
  -H "Content-Type: application/json" \
  -H "X-Master-Admin-Key: <MASTER_ADMIN_KEY>" \
  -d '{
    "facilityId": "INXXXXXXXXXX",
    "facilityName": "First Hospital",
    "tenantCode": "FIRST_HOSPITAL",
    "connectorBaseUrl": "https://first-hospital-api.mediqliq.com",
    "hfrStatus": "APPROVED",
    "softwareLinkageStatus": "LINKED",
    "services": { "hip": true, "hiu": false }
  }'
```

The response returns a **one-time connector key ID and connector secret**. Put those values only in that hospital server's environment:

```env
ABDM_MASTER_URL=https://api.mediqliq.com
ABDM_FACILITY_ID=INXXXXXXXXXX
ABDM_TENANT_CODE=FIRST_HOSPITAL
ABDM_CONNECTOR_KEY_ID=...
ABDM_CONNECTOR_SECRET=...
```

Then check connectivity from the master:

```bash
curl -X POST \
  -H "X-Master-Admin-Key: <MASTER_ADMIN_KEY>" \
  "https://api.mediqliq.com/api/abdm/master/facilities/INXXXXXXXXXX/check-connector"
```

## 5. M1 ABHA changes included

The code now:

- uses the V3 gateway session headers and `grantType=client_credentials`;
- fixes the Aadhaar enrolment endpoint spelling to `/byAadhaar`;
- keeps the ABDM client secret only on the central master;
- proxies hospital ABHA calls through the HMAC-authenticated master connector;
- supports mobile search + OTP verification for an existing ABHA;
- marks manual ABHA entry as `VERIFICATION_PENDING`, not verified;
- uses authenticated Blob requests for ABHA QR/card downloads;
- uses `VITE_BACKEND_URL` on the Vite frontend.

## 6. M2 HIP callback architecture included

Public master callback routes include:

- `/api/v3/hip/patient/share`
- `/api/v3/hip/token/on-generate-token`
- `/api/v3/link/on_carecontext`
- `/api/v3/links/context/on-notify`
- `/api/v3/patients/sms/on-notify`
- `/api/v3/hip/patient/care-context/discover`
- `/api/v3/hip/link/care-context/init`
- `/api/v3/hip/link/care-context/confirm`
- `/api/v3/consent/request/hip/notify`
- `/api/v3/hip/health-information/request`

Callbacks are accepted quickly, de-duplicated, stored as control-plane events and processed asynchronously through the master job worker.

The master routes the callback by Facility/HIP ID to the correct hospital server and signs the private request using that facility's HMAC connector secret.

## 7. Scan & Share flow

Implemented flow:

```text
Patient scans facility QR
  -> ABDM calls central /api/v3/hip/patient/share
  -> Master resolves Facility ID
  -> Master routes to that hospital /internal/abdm/profile-share
  -> Hospital finds or creates the patient using verified ABDM profile data
  -> Hospital generates a local counter token
  -> Master sends the ABDM on-share acknowledgement
```

The hospital must contain a valid `Hospital` record because the existing `Patient` pre-save hook uses it to generate patient identifiers.

## 8. Care-context linking

### HIP-initiated

From the patient profile, the frontend can:

1. Build/refresh local care contexts.
2. Start ABDM HIP-initiated linking for a **VERIFIED** ABHA patient.
3. The hospital asks the master to generate a link token.
4. The master receives the asynchronous link-token callback and routes it back to the hospital.
5. The hospital sends the selected care contexts for linking.
6. The final ABDM callback updates local `AbdmCareContext.linkStatus`.

### User-initiated

Discovery, link-init and link-confirm callback plumbing is included.

The HIP must send an OTP to the patient's registered mobile. Configure either:

- a real SMS provider webhook using `ABDM_SMS_PROVIDER_URL`, or
- `ABDM_LINK_OTP_TEST_MODE=true` only for controlled sandbox testing. In test mode the OTP is written to the hospital server console and is never returned to ABDM.

## 9. FHIR/HI-type implementation

Dedicated generation exists for the eight HMIS HI-type groups:

- Prescription
- DiagnosticReport
- OPConsultation
- DischargeSummary
- ImmunizationRecord
- HealthDocumentRecord
- WellnessRecord
- Invoice

New local models were added for gaps in the existing ERP:

- `Immunization`
- `ClinicalDocument`

The generated bundles are implementation scaffolding mapped to the current ERP models. Before certification, validate every generated bundle against the exact ABDM/NRCeS FHIR profiles and terminology requirements used by the current sandbox certification suite.

## 10. Consent and health-information data flow

The master stores consent metadata and routes health-information requests to the correct hospital.

The hospital:

- resolves the consented care contexts;
- generates the requested FHIR bundles for the allowed date range;
- acknowledges the health-information request;
- returns the plaintext FHIR records only through the private HMAC connector to the master.

The master contains data-push orchestration, but **encryption is fail-closed by default**:

```env
ABDM_DATA_PUSH_MODE=disabled
```

For certification-critical Curve25519 encryption, configure a validated ABDM/NHA-compatible crypto adapter:

```env
ABDM_DATA_PUSH_MODE=external
ABDM_CRYPTO_ADAPTER_URL=https://your-validated-crypto-adapter/abdm/encrypt
ABDM_CRYPTO_ADAPTER_TOKEN=...
```

The adapter must return:

```json
{
  "entries": [
    {
      "content": "<encrypted content>",
      "media": "application/fhir+json",
      "checksum": "<checksum>",
      "careContextReference": "<care context reference>"
    }
  ],
  "keyMaterial": {
    "cryptoAlg": "ECDH",
    "curve": "Curve25519",
    "dhPublicKey": {},
    "nonce": "..."
  }
}
```

The repository deliberately does not guess the certification-critical encryption envelope. Connect the exact validated implementation used for the current ABDM sandbox before enabling data push.

## 11. M3 status

M3/HIU remains disabled:

```env
ABDM_ENABLE_M3=false
```

The existing legacy PHR consent endpoint remains a stub. M3 should be implemented as a separate HIU project after the first hospital's M1/M2 HIP onboarding is stable.

## 12. Security changes

- ABDM client credentials remain only on the master.
- Each hospital gets a separate HMAC connector credential.
- Connector secrets are AES-256-GCM encrypted in the master database.
- Master admin APIs require `X-Master-Admin-Key`.
- Permission checks are now enabled by default. `DISABLE_PERMISSION_CHECKS=true` must never be used in production.
- Helmet and API rate limiting are enabled.
- Callback payload persistence is disabled by default to reduce sensitive-data retention.
- Optional callback IP allow-listing and JWT verification are available through environment settings.

## 13. What still requires external action before first live hospital onboarding

Code alone cannot provide these:

- rotated ABDM sandbox credentials;
- the first hospital's approved NHPR/HFR Facility ID;
- completed NHPR/HFR Software Linkage to the MediQliq Bridge ID;
- a valid public HTTPS master domain/certificate;
- real hospital connector domain/HTTPS;
- Scan & Share QR/counter configuration;
- a real SMS provider for user-initiated linking (or controlled sandbox OTP test mode);
- validated ABDM data-flow crypto implementation;
- sandbox conformance/certification testing and production credentials.

## 14. Recommended first-hospital order

1. Rotate all exposed secrets.
2. Deploy the central master.
3. Validate V3 gateway authentication and bridge URL.
4. Obtain/verify the hospital Facility ID and complete Software Linkage.
5. Register the hospital in the master and configure its connector credentials.
6. Test master -> hospital connector health.
7. Test M1 ABHA creation and existing-ABHA verification.
8. Test Scan & Share end-to-end.
9. Test HIP-initiated care-context linking.
10. Configure SMS and test user-initiated linking.
11. Validate all eight FHIR HI types.
12. Integrate the validated data-flow crypto adapter and test consent-based health-information push.
13. Complete sandbox acceptance before production migration.
