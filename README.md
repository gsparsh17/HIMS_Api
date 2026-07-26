# MediQliq Hospital Backend — ABDM M1, M2 and M3

This is the hospital-only backend fork of the combined HIMS API. It retains the existing clinical and operational HIMS APIs while removing the MediQliq master, super-admin and public ABDM callback surfaces.

The hospital talks to the separate MediQliq Master through a unique HMAC connector. The ABDM client ID and client secret stay only on the master.

## Hospital responsibilities

### M1 — ABHA identity

- Aadhaar OTP enrolment through the master ABHA proxy
- Existing ABHA search and OTP verification
- Mobile verification
- ABHA Address suggestion, validation and creation
- ABHA card and QR retrieval
- Explicit consent evidence
- Patient/user/hospital-bound ABDM transactions
- OTP attempts, expiry, resend controls and lockout
- Unique ABHA-to-patient mapping inside each hospital
- Encrypted ABHA access and refresh tokens

### M2 — HIP

- Scan-and-Share profile callbacks and queue/token acknowledgement
- Safe patient discovery
- User-initiated and HIP-initiated care-context linking
- Stable care-context references for all eight HI types
- Consent callback storage and scope enforcement
- NRCeS FHIR document generation and validation hooks
- Hospital-side encryption and direct HIU data push
- Idempotent transfer records, retries and job monitoring

### M3 — HIU

- Consent request, status and artefact retrieval orchestration
- Receiver key-material generation through a crypto adapter
- Health-information request initiation
- Encrypted data receive, decrypt and checksum processing
- Consent-scope and date-range enforcement before import
- Encrypted FHIR storage with source/provenance metadata
- Revoked/expired consent enforcement
- Audited external-record viewing
- Optional subscription plumbing

## Security boundaries

- No full Aadhaar field is present in the current Patient schema.
- Patient identifiers are not generated from Aadhaar.
- ABHA tokens, consent artefacts, imported FHIR bundles and HIU private key material are AES-256-GCM encrypted at rest.
- Connector requests use canonical JSON HMAC signatures, timestamps and persisted replay IDs.
- ABDM records are scoped by `hospitalId` even if a MongoDB cluster is temporarily shared.
- Production rejects mock cryptography.
- Production can require external consent-integrity validation and NRCeS package validation.
- Outbound crypto, validator and HIU URLs are protected with explicit host allow-lists and SSRF checks.

## Local start

```bash
cp .env.hospital.example .env
npm ci
npm run abdm:validate
npm run check:syntax
npm run abdm:test
npm run abdm:migrate
npm run abdm:migrate -- --apply
npm run dev
```

The MediQliq Master normally runs on port `5004`; this hospital backend defaults to port `5000`.

You may temporarily use the same MongoDB connection string as the earlier backend, but use a separate database before production. Always run the migration in dry-run mode first and resolve duplicate ABHA mappings before applying indexes.

## External services required for a real end-to-end exchange

Development can exercise orchestration with mock cryptography. Sandbox/certification requires:

- A live MediQliq Master configured for the current ABDM V3 contract
- Valid per-hospital connector credentials
- A reviewed ABDM-compatible crypto implementation
- A consent artefact signature/integrity validator
- An NRCeS FHIR validator configured for the assigned implementation-guide version
- Approved outbound host allow-lists
- SMS delivery for user-initiated linking

The repository implements the hospital-side workflow and security boundaries, but certification still depends on live gateway behavior, current official collections, assigned FHIR profiles and external cryptographic conformance.

## Documentation

- `docs/API.md` — hospital API surface
- `docs/MASTER_CONTRACT.md` — master-to-hospital connector contract
- `docs/CRYPTO_ADAPTER.md` — crypto adapter interface
- `docs/CONSENT_VALIDATOR.md` — consent validator interface
- `BUILD_REPORT.md` — build and validation summary

## Consent PDF fonts

Font binaries are not bundled with this source archive. For bilingual Hindi/English consent PDFs, install a Devanagari-capable font on the host or mount your approved font files and configure:

```env
DEVANAGARI_FONT_PATH=/absolute/path/to/Devanagari-Regular.ttf
DEVANAGARI_BOLD_FONT_PATH=/absolute/path/to/Devanagari-Bold.ttf
```

The application also attempts to locate an installed `Noto Sans Devanagari` font through the operating system font configuration.
