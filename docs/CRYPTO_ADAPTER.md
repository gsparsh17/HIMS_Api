# ABDM crypto adapter contract

The hospital backend does not guess or silently downgrade certification-critical health-information cryptography. In `external` mode it calls a separately reviewed adapter.

Configure:

```env
ABDM_CRYPTO_MODE=external
ABDM_CRYPTO_ADAPTER_URL=https://crypto.internal.example
ABDM_CRYPTO_ADAPTER_ALLOWED_HOSTS=crypto.internal.example
ABDM_CRYPTO_ADAPTER_TOKEN=<service-token>
```

## `POST /v1/receiver-key-material`

Request:

```json
{
  "requestId": "uuid",
  "consentId": "consent-id",
  "expiresAt": "ISO-8601"
}
```

Response:

```json
{
  "publicKeyMaterial": {
    "cryptoAlg": "ECDH",
    "curve": "Curve25519",
    "dhPublicKey": {
      "expiry": "ISO-8601",
      "parameters": "...",
      "keyValue": "base64"
    },
    "nonce": "base64"
  },
  "privateMaterial": {
    "adapterDefined": "secret material retained encrypted by the hospital"
  }
}
```

## `POST /v1/encrypt`

Request contains `transactionId`, ABDM peer `peerKeyMaterial` and records with `careContextReference`, `hiType` and FHIR `content`.

Response:

```json
{
  "entries": [
    {
      "content": "encrypted-base64",
      "media": "application/fhir+json",
      "checksum": "checksum",
      "careContextReference": "reference"
    }
  ],
  "keyMaterial": {}
}
```

## `POST /v1/decrypt`

Request contains `transactionId`, the locally retained `privateMaterial`, sender `keyMaterial` and encrypted `entries`.

Response:

```json
{
  "records": [
    {
      "content": "FHIR JSON string or object",
      "careContextReference": "reference",
      "hiType": "Prescription",
      "sourceHipId": "HIP_ID",
      "sourceName": "Source hospital"
    }
  ]
}
```

The adapter must implement the exact key exchange, nonce ordering, checksum and serialization rules assigned by the current ABDM V3 certification contract. The mock mode only base64-encodes content and is never valid for sandbox evidence or production.
