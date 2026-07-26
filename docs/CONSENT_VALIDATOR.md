# Consent artefact validator contract

The hospital can delegate consent artefact signature and integrity validation to a reviewed internal service.

Configure:

```env
ABDM_CONSENT_VALIDATOR_URL=https://validator.internal.example/v1/validate-consent
ABDM_CONSENT_VALIDATOR_ALLOWED_HOSTS=validator.internal.example
ABDM_REQUIRE_CONSENT_VALIDATION=true
```

The hospital sends:

```json
{
  "artefact": {},
  "environment": "sandbox",
  "hipId": "FACILITY_HIP_ID",
  "hiuId": "FACILITY_HIU_ID"
}
```

The validator must respond with HTTP 2xx and:

```json
{
  "valid": true,
  "issuer": "validated issuer",
  "algorithm": "validated algorithm",
  "keyId": "validated signing key",
  "claims": {},
  "evidence": {}
}
```

A response with `valid` other than `true`, a network failure or an unapproved destination prevents consent use when validation is required. The hospital stores only validation metadata and an encrypted copy of the artefact.
