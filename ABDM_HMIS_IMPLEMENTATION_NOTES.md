# ABDM-enabled HMIS implementation notes

This patch adds ABDM/ABHA starter implementation to the existing HIMS backend and React frontend.

## Covered features

1. ABHA-based patient registration and linking by Aadhaar OTP.
2. Manual capture of an existing ABHA Number / ABHA Address.
3. ABHA metadata stored on the local Patient record.
4. ABHA card / QR proxy endpoints using a recent ABHA X-token.
5. Frontend ABHA flow on patient profile and after OPD/IPD registration.
6. Mandatory ABHA registration status field on OPD/IPD registration forms.
7. ABHA-based patient search.
8. Local ABDM record linking metadata for OPD/IPD, prescription, diagnosis, lab, radiology and discharge records.
9. FHIR-style EHR/EMR bundle generation from local records.
10. Placeholder endpoint for future ABDM consent / PHR integration.

## Environment variables

Copy `.env.abdm.example` values into your backend `.env`:

```env
ABDM_ENV=sandbox
ABDM_CLIENT_ID=replace_with_abdm_client_id
ABDM_CLIENT_SECRET=replace_with_abdm_client_secret
ABDM_SESSION_URL=https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions
ABDM_ABHA_BASE_URL=https://abhasbx.abdm.gov.in/abha/api
```

## New backend endpoints

```txt
POST /api/abha/aadhaar/request-otp
POST /api/abha/aadhaar/enrol
POST /api/abha/capture-existing
POST /api/abha/mobile/request-otp
POST /api/abha/mobile/verify-otp
GET  /api/abha/patients/search
GET  /api/abha/patients/:patientId/qr-code
GET  /api/abha/patients/:patientId/card
POST /api/abha/records/link
POST /api/abha/records/link-patient-records/:patientId
POST /api/abha/ehr/generate
GET  /api/abha/ehr/patient/:patientId
GET  /api/abha/ehr/bundle/:bundleId
POST /api/abha/phr/consent/request
```

## Important production notes

- Do not store full Aadhaar long-term. This patch marks `aadhaar_number` as `select: false` and adds `aadhaar_last4`.
- The ABHA X-token is short-lived and sensitive. For production, encrypt token values at rest or avoid storing them and require fresh ABHA login for card/QR download.
- The generated EHR bundle is a local FHIR-style starter bundle. Actual ABDM health information exchange requires formal HIP/HIU integration, consent artefact handling, callbacks and ABDM certification.
- The PHR consent endpoint is intentionally a 501 stub so your product has a clear integration point without pretending to have full consent exchange.
