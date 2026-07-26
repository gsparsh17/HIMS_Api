# MediQliq Master ↔ Hospital contract

## Hospital to master

All requests are made to the master base URL using canonical JSON HMAC headers:

- `X-MediQliq-Facility-ID`
- `X-MediQliq-Key-ID`
- `X-MediQliq-Timestamp`
- `X-MediQliq-Request-ID`
- `X-MediQliq-Signature`

Supported master endpoints:

- `GET /internal/abdm/health`
- `GET /internal/abdm/facility-status`
- `POST /internal/abdm/m1/proxy`
- `POST /internal/abdm/m2/action`
- `POST /internal/abdm/m3/action`
- `POST /internal/abdm/m3/data-relay-token`

## Master to hospital

The master signs requests with the facility connector secret and sends them to the configured hospital connector base URL.

M2 paths:

- `POST /internal/abdm/profile-share`
- `POST /internal/abdm/discover`
- `POST /internal/abdm/link/init`
- `POST /internal/abdm/link/confirm`
- `POST /internal/abdm/link-token`
- `POST /internal/abdm/link-care-context`
- `POST /internal/abdm/care-context-update`
- `POST /internal/abdm/sms-notify`
- `POST /internal/abdm/consent/notify`
- `POST /internal/abdm/health-information/request`

M3 paths:

- `POST /internal/abdm/hiu/consent/on-init`
- `POST /internal/abdm/hiu/consent/notify`
- `POST /internal/abdm/hiu/consent/on-status`
- `POST /internal/abdm/hiu/consent/on-fetch`
- `POST /internal/abdm/hiu/health-information/on-request`
- `POST /internal/abdm/hiu/data`
- Subscription callbacks when enabled

Every hospital callback is idempotent or queued with a deterministic idempotency key. A mismatched HIP/HIU identity, key ID, signature, timestamp or replay ID is rejected.
