# MediQliq ABDM consent validator

Private, fail-closed consent authorization service for M2 HIP and M3 HIU workflows.

It performs:

- compact-JWS signature verification using an approved JWKS or pinned keys;
- signed-payload binding and artefact hashing;
- status, validity, expiry and revocation checks;
- patient, HIP, HIU, purpose, HI type, care-context and date-range checks;
- operation-bound authorization hashes;
- durable frequency reservations and commit/release processing;
- retention calculation and enforcement metadata;
- PHI-minimized decision/status storage.

## Important contract freeze

The service supports a compact JWS proof located in `proof.jws`, `signature`, or `signedConsent`. The signed payload must contain the same consent object as the supplied artefact. Before certification, map the exact current ABDM consent-signature envelope and trust endpoints to this adapter using written NHA/agency guidance. Do not enable unsigned mode in production. Remote trust retrieval also requires an exact `CONSENT_VALIDATOR_JWKS_ALLOWED_HOSTS` hostname allowlist.

## API

- `POST /v1/validate`
- `POST /v1/status-events`
- `POST /v1/usage/:reservationId/commit`
- `POST /v1/usage/:reservationId/release`
- `GET /health/live`
- `GET /health/ready`
- `GET /version`

Every `/v1` route requires `X-MediQliq-Service-Token` or a Bearer token. The service must have no public ingress; mTLS should be enforced by the service mesh/reverse proxy in addition to the token.

## Frequency semantics

By default, ABDM `frequency.repeats` is interpreted as additional uses, so `repeats: 0` permits one use in the window. Set `CONSENT_VALIDATOR_FREQUENCY_REPEATS_MODE=TOTAL` only when the approved contract defines repeats as the total count.

## Run

From the Hospital Backend repository root:

```bash
npm ci
node apps/consent-validator/server.js
```

Build from the repository root:

```bash
docker build -f apps/consent-validator/Dockerfile -t mediqliq-abdm-consent-validator:1.0.0 .
```
