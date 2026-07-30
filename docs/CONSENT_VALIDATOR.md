# MediQliq ABDM consent validator

The Hospital Backend now contains a deployable, private consent authorization service under `apps/consent-validator`.

It is not a public ABDM callback service. The Hospital Backend is its only normal caller.

## Production decision

A consent is usable only when all of the following pass:

- the supplied consent payload is bound to a cryptographically verified proof;
- signing algorithm, issuer, audience and key ID are trusted;
- current lifecycle status is `GRANTED` and the consent is within its validity period;
- patient, HIP, HIU, purpose, HI types, care contexts and clinical date range match the exact operation;
- frequency has an atomic durable reservation where the operation consumes frequency;
- requested retention is within the consent and organization policy;
- the authorization decision is bound to the transaction, packet/payload hash and hospital operation.

Network, trust or database failures deny the operation.

## Contract-freeze requirement

The implementation includes a compact-JWS verification adapter. The exact current ABDM consent proof envelope, canonical payload and trust/JWKS endpoint must be confirmed in writing with NHA or the appointed testing agency before certification. Do not treat the generic adapter as evidence that a particular ABDM signature format has been approved.

Supported proof locations are `proof.jws`, `signature`, `signature.jws` and `signedConsent`. The signed payload must include the same consent object as the outer artefact. Detached/unencoded JWS is rejected by this profile.

## Hospital Backend configuration

```env
ABDM_CONSENT_VALIDATOR_URL=http://mediqliq-consent-validator:8180/v1/validate
ABDM_CONSENT_VALIDATOR_HEALTH_URL=http://mediqliq-consent-validator:8180/health/ready
ABDM_CONSENT_VALIDATOR_ALLOWED_HOSTS=mediqliq-consent-validator
ABDM_CONSENT_VALIDATOR_TOKEN=<same secret as CONSENT_VALIDATOR_SERVICE_TOKEN>
ABDM_REQUIRE_CONSENT_VALIDATION=true

ABDM_TRUSTED_INTERNAL_SERVICE_HOSTS=mediqliq-fhir-validator,mediqliq-crypto-adapter,mediqliq-consent-validator
ABDM_TRUSTED_INTERNAL_SERVICE_PORTS=3500,8090,8180
```

## Request contract

```json
{
  "artefact": {},
  "environment": "sandbox",
  "operation": {
    "type": "HIP_DISCLOSURE",
    "operationId": "transaction-id",
    "hospitalId": "hospital-id",
    "patientId": "patient@abdm",
    "hipId": "HIP-ID",
    "hiuId": "HIU-ID",
    "purpose": { "code": "CAREMGT" },
    "hiTypes": ["Prescription"],
    "careContextIds": ["CC-001"],
    "dateRange": {
      "from": "2026-01-01T00:00:00.000Z",
      "to": "2026-01-31T23:59:59.999Z"
    },
    "packetHash": "sha256-hex"
  },
  "expected": {
    "consentId": "consent-id",
    "patientId": "patient@abdm",
    "hipId": "HIP-ID",
    "hiuId": "HIU-ID",
    "hospitalId": "hospital-id"
  }
}
```

Operation types are limited to:

- `REGISTER_ARTEFACT`
- `HIP_DISCLOSURE`
- `HIU_DATA_REQUEST`
- `HIU_IMPORT`

## Required successful response

```json
{
  "valid": true,
  "decision": "PERMIT",
  "validationId": "uuid",
  "artefactHash": "sha256-hex",
  "signatureVerified": true,
  "integrityVerified": true,
  "trust": {
    "issuer": "trusted issuer",
    "audience": "expected audience",
    "keyId": "signing-key-id",
    "algorithm": "RS256"
  },
  "verifiedScope": {},
  "lifecycleStatus": "GRANTED",
  "authorizedOperationHash": "sha256-hex",
  "usage": {
    "reservationId": "uuid",
    "status": "RESERVED"
  },
  "retentionUntil": "2026-08-01T00:00:00.000Z",
  "validatedAt": "2026-07-29T00:00:00.000Z",
  "decisionExpiresAt": "2026-07-29T00:05:00.000Z"
}
```

The Hospital Backend independently compares the returned verified scope with its expected operation. A bare `valid: true` response is rejected.

## Endpoints

- `POST /v1/validate`
- `POST /v1/status-events`
- `POST /v1/usage/:reservationId/commit`
- `POST /v1/usage/:reservationId/release`
- `GET /health/live`
- `GET /health/ready`
- `GET /version`

Every `/v1` endpoint requires the service token. Health and version endpoints are intended only for private probes.

## Deployment

```bash
cp apps/consent-validator/.env.example apps/consent-validator/.env
npm run consent-validator:test
docker compose -f docker-compose.abdm-services.yml build mediqliq-consent-validator
docker compose -f docker-compose.abdm-services.yml up -d mediqliq-consent-validator
```

Production frequency enforcement requires MongoDB replica-set transactions. Existing stored consents created before this patch should be re-fetched so their cryptographically verified artefact hash and evidence fields are populated.


Remote trust endpoints must be explicitly allowlisted with `CONSENT_VALIDATOR_JWKS_ALLOWED_HOSTS`; redirects and credential-bearing URLs are rejected.
