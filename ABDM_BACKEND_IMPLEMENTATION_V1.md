# MediQliq Hospital ABDM Backend — Hybrid Shared-Service Providers

The Hospital backend remains the clinical/source-of-truth application. FHIR
validation, ABDM cryptography and consent validation are called through stable
Hospital-side service wrappers and may be provided by either:

- `master` — the shared MediQliq Master Backend platform; or
- `local` — a hospital-local deployment of the same reviewed service images.

The Hospital frontend never calls these compute services directly and never
receives their service credentials.

## Provider configuration

```env
ABDM_FHIR_PROVIDER=master
ABDM_FHIR_FALLBACK_PROVIDER=none
ABDM_CRYPTO_PROVIDER=master
ABDM_CONSENT_PROVIDER=master
```

For a hospital-local deployment, change only the required provider(s) to
`local` and configure the corresponding local URL/token/allow-list settings.
Mixed deployments are supported, for example Master FHIR with local Crypto and
Consent.

FHIR validation is stateless, so an optional explicit FHIR fallback may be
configured. Crypto and Consent do not automatically fail over across providers:
receiver key handles and consent usage reservations are bound to the provider
that created them.

## Source ownership

The FHIR Validator, Crypto Adapter and Consent Validator source code is owned by
the MediQliq Master Backend repository. If a hospital later needs local compute,
deploy the same versioned images on that hospital's server rather than keeping a
second copy of the service source in the HIMS repository.
