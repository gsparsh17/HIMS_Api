# Build report

This repository was forked from the uploaded combined HIMS backend and converted into a hospital-only HIMS/ABDM service.

## Reused

- Existing HIMS clinical, pharmacy, IPD, billing, HR and operational modules
- Existing ABHA master-proxy pattern
- Care-context discovery logic
- Source mappings for all eight ABDM HI types
- Existing Scan-and-Share and linking callback foundations
- Per-facility HMAC connector concept

## Added or replaced

- Hospital-only route and startup surface
- Secure M1 transaction ownership, consent evidence and OTP controls
- Encrypted ABHA credentials outside the Patient model
- Full Aadhaar removal and random/non-Aadhaar patient IDs
- Hospital-scoped care contexts, transactions, consents, transfers and imported records
- Canonical HMAC signing and replay persistence
- Asynchronous M2 HIP transfer jobs
- Consent scope, date-range and HI-type enforcement
- External FHIR and consent-validator hooks
- External/mock crypto adapter contract with production mock rejection
- M3 consent, HI-request, encrypted receive/decrypt/import and viewer APIs
- AES-256-GCM encryption for consent artefacts, imported FHIR and private key material
- Access audit records for imported health information
- Migration, configuration validator, route-surface tests and Docker files

## Validation performed during packaging

- Repository-wide JavaScript syntax validation
- Relative CommonJS import resolution
- ABDM route-surface tests
- Canonical HMAC tests
- Vault authentication/encryption tests
- FHIR structural validation tests
- Secret-pattern scan
- ZIP content and SHA-256 verification

## External acceptance boundary

The code supplies the complete hospital-side implementation surface. It cannot itself prove ABDM certification. Live completion requires current master/gateway payload contract tests, real facility linkage, a conformant crypto implementation, valid consent artefact verification, NRCeS package validation, sandbox callbacks and official negative-path evidence.
