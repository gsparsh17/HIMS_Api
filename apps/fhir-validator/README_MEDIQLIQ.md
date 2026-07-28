# MediQliq ABDM FHIR Validator

This deployable is the upstream HAPI FHIR validator-wrapper with the official
`ndhm.in#6.5.0` package preloaded. It is an internal-only service.

Build:

```bash
docker build -f Dockerfile.mediqliq -t mediqliq-fhir-validator:6.5.0 .
```

Hospital Backend configuration:

```env
ABDM_FHIR_VALIDATOR_URL=http://mediqliq-fhir-validator:3500/validate
ABDM_FHIR_VALIDATOR_MODE=hapi-wrapper
ABDM_FHIR_VALIDATOR_HEALTH_URL=http://mediqliq-fhir-validator:3500/validator/version
ABDM_FHIR_VALIDATOR_ALLOWED_HOSTS=mediqliq-fhir-validator
ABDM_TRUSTED_INTERNAL_SERVICE_HOSTS=mediqliq-fhir-validator,mediqliq-crypto-adapter
ABDM_TRUSTED_INTERNAL_SERVICE_PORTS=3500,8090
ABDM_FHIR_PACKAGE=ndhm.in#6.5.0
ABDM_FHIR_VERSION=4.0.1
ABDM_REQUIRE_EXTERNAL_FHIR_VALIDATION=true
```

The Hospital Backend sends the wrapper's native `/validate` request contract.
No FHIR payload is logged by the patched validation route. Do not expose this
service through a public ingress.
