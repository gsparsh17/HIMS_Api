# Patient Portal + ABDM PHR + Face Auth integration

## Architecture
The patient portal is part of the same hospital frontend/backend deployment, but it has an independent patient security boundary. `/api/patient-portal/*` uses a patient-scoped JWT (`patientPortal=true`, `patientId`, `hospitalId`, role `patient`) and does not reuse staff authorization. These routes are mounted before the global staff `/api` guard.

The intended URLs are:
- staff: `/` and `/dashboard/*`
- patient: `/patient/login` and `/patient/*`

For internet access, expose the patient routes through HTTPS/reverse proxy. Prefer keeping staff routes LAN/VPN restricted.

## Patient authentication
Implemented patient-facing choices:
- Hospital mobile OTP -> local patient profile -> patient JWT.
- Aadhaar OTP through ABDM -> verified ABHA -> map to hospital patient -> patient JWT.
- ABHA Address + linked-mobile/Aadhaar OTP -> verified ABHA -> patient JWT.
- ABHA App Face Auth QR: encrypted-mobile ABHA search -> select index -> create Face Auth transaction -> QR -> poll `capturePID` every 5 seconds -> `COMPLETE` -> login verify -> patient JWT.

A normal ABHA profile QR is deliberately not treated as authentication. Aadhaar is encrypted for the ABDM request and is not stored by this module.

Configure production hospital OTP delivery with `PATIENT_PORTAL_SMS_PROVIDER_URL` and optionally `PATIENT_PORTAL_SMS_PROVIDER_TOKEN`. `PATIENT_PORTAL_OTP_TEST_MODE=true` is local/sandbox only.

## M1 Face Auth migration
Two staff-facing face flows are changed/added:

### Existing ABHA / Find ABHA Face QR
The existing mobile search screen can now select an ABHA and choose **Face Auth QR** instead of OTP. Backend endpoints:
- `POST /api/abha/existing/face/request`
- `POST /api/abha/existing/face/status`
- `POST /api/abha/existing/face/verify`

The legacy browser face-PID login is explicitly disabled.

### ABHA creation using Face Auth QR
The existing biometric enrollment flow is migrated from browser-provided face PID to the ABHA App QR model:
1. init with `abha-enrol + face-auth`
2. QR uses `ABDM_PHR_FACE_AUTH_URL` (defaults to sandbox PHR face-auth URL)
3. `capturePID` polls with `abha-enrol + face-verify`
4. only `COMPLETE` continues
5. `/enrol/byAadhaar` uses `authMethods: [face_auth]` and `{ txnId, encrypted aadhaar, mobile }`

Fingerprint/iris RD-service paths are intentionally left unchanged.

## Patient portal modules
- responsive patient dashboard
- upcoming/historic appointments
- prescriptions
- medication history extracted from prescriptions
- current/historic admissions
- lab reports
- hospital clinical/encounter health files
- bills
- IPD clinical consent review, fill/save, and typed signing
- patient feedback/experience ratings
- ABHA/PHR overview
- imported ABDM health records
- ABDM consent history
- PHR subscription request list + approve/deny
- PHR health-locker list

Hospital clinical consent and ABDM health-information consent remain separate concepts and data models.

## PHR / M3 reuse
The portal reuses the existing HIMS M3/PHR foundation (`AbdmHospitalConsent`, `AbdmImportedRecord`, patient ABDM credentials, Master `/internal/abdm/m3/action`) instead of duplicating it. The new patient endpoints invoke only M3 actions already present in this HIMS repository (patient subscription requests, approve/deny, patient lockers), and display existing imported records/consents.

ABDM certification and any additional Master-side action that is not present in the uploaded HIMS repository still requires the corresponding ABDM Master repository/configuration. This bundle does not fabricate unknown Master contracts.

## Environment/configuration
Required existing configuration remains required (`JWT_SECRET`, ABDM master/proxy configuration, MongoDB, etc.). New/important settings:

```env
# QR destination used by ABDM sandbox/production Face Auth
ABDM_PHR_FACE_AUTH_URL=https://phrsbx.abdm.gov.in/face-auth

# Patient portal JWT lifetime in minutes (default 720)
PATIENT_PORTAL_SESSION_MINUTES=720

# Hospital-local OTP SMS adapter
PATIENT_PORTAL_SMS_PROVIDER_URL=
PATIENT_PORTAL_SMS_PROVIDER_TOKEN=
PATIENT_PORTAL_SMS_TEMPLATE=Your OTP is {{otp}}

# Never enable in production
PATIENT_PORTAL_OTP_TEST_MODE=false
```

## Production safety checklist
- HTTPS only for remote patient access.
- Rate-limit public OTP, Aadhaar, ABHA Address and Face Auth endpoints at reverse proxy/API gateway.
- Keep staff `/dashboard/*` LAN/VPN-only where possible.
- Never log Aadhaar, OTP, ABDM access/refresh tokens, PID data, or signature payloads.
- Ensure each hospital deployment contains only its own hospital data/configuration.
- Back up and audit consent/signature records.
- Run the official ABDM PHR/M1/M2/M3 test suites against the target sandbox before production certification.
