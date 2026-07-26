# Hospital ABDM API surface

All `/api/*` routes require the existing hospital JWT and role authorization. All `/internal/abdm/*` routes require the MediQliq HMAC connector signature.

## M1 — `/api/abha`

- `POST /aadhaar/request-otp`
- `POST /aadhaar/enrol`
- `POST /existing/search-mobile`
- `POST /existing/request-otp`
- `POST /existing/verify-otp`
- `POST /mobile/request-otp`
- `POST /mobile/verify-otp`
- `POST /address/suggestions`
- `POST /address/validate`
- `POST /address/create`
- `GET /patients/:patientId`
- `GET /patients/:patientId/qr-code`
- `GET /patients/:patientId/card`

OTP-starting requests require:

```json
{
  "consentAccepted": true,
  "consentVersion": "1.4",
  "consentText": "The exact UI consent text shown to the patient"
}
```

The text itself is not retained; a SHA-256 hash and acceptance evidence are stored.

## M2 hospital-user APIs — `/api/abdm`

- `GET /integration/status`
- `POST /care-contexts/build/:patientId`
- `GET /care-contexts/patient/:patientId`
- `GET /care-contexts/patient/:patientId/grouped`
- `POST /care-contexts/:contextId/notify-update`
- `POST /linking/hip/initiate/:patientId`
- `POST /fhir/generate`
- `POST /fhir/validate`
- `GET /transfers`
- `GET /jobs`
- `POST /jobs/:jobId/retry`

## M3 hospital-user APIs — `/api/abdm/hiu`

- `GET /summary`
- `POST /consents`
- `GET /consents`
- `GET /consents/:consentId`
- `POST /consents/:consentId/status`
- `POST /consents/:consentId/fetch`
- `POST /consents/:consentId/health-information`
- `GET /requests`
- `GET /patients/:patientId/records`
- `GET /records/:recordId`
- `POST /subscriptions` when enabled

Example consent request:

```json
{
  "patientId": "LOCAL_MONGODB_PATIENT_ID",
  "purpose": {
    "text": "Care Management",
    "code": "CAREMGT",
    "refUri": "https://terminology.hl7.org/CodeSystem/v3-ActReason"
  },
  "hiTypes": ["PRESCRIPTION", "DIAGNOSTIC_REPORT", "OP_CONSULTATION"],
  "dateRange": {
    "from": "2026-01-01T00:00:00.000Z",
    "to": "2026-07-31T23:59:59.999Z"
  },
  "consentExpiry": "2026-08-01T23:59:59.999Z",
  "requester": {
    "name": "Dr Example",
    "identifier": "HPR_OR_LOCAL_IDENTIFIER"
  }
}
```

## Master callback connector — `/internal/abdm`

M2:

- `/profile-share`
- `/discover`
- `/link/init`
- `/link/confirm`
- `/link-token`
- `/link-care-context`
- `/care-context-update`
- `/sms-notify`
- `/consent/notify`
- `/health-information/request`

M3:

- `/hiu/consent/on-init`
- `/hiu/consent/notify`
- `/hiu/consent/on-status`
- `/hiu/consent/on-fetch`
- `/hiu/health-information/on-request`
- `/hiu/data`
- subscription callbacks when enabled
