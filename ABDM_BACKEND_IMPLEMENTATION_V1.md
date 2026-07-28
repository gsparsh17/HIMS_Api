# MediQliq ABDM Backend Implementation v1

This patch keeps the Hospital ecosystem in one Git repository while producing
three independently deployable images:

1. Hospital API (existing root Dockerfile)
2. NRCeS/HAPI FHIR validator (`apps/fhir-validator`)
3. Fidelius-based crypto adapter (`apps/crypto-adapter`)

It also adds the Hospital ABDM Packet Center and Master dependency-readiness
reporting. Packet versions bind the source snapshot, consent scope, exact FHIR
bundle hash, external validation evidence and clinical approval before M2 data
transfer.

## Apply order

1. Copy the changed/new files over the corresponding repositories.
2. Install dependencies in both Node repositories.
3. Run Master tests and syntax checks.
4. Run Hospital ABDM tests and syntax checks.
5. Build the two internal service images in a network-enabled CI runner.
6. Configure secret-manager values and exact service DNS allowlists.
7. Deploy internal services with no public ingress.
8. Enable fail-closed FHIR, crypto and consent validation only after health and
   interoperability tests pass.

## Important

The crypto image is an integration of the uploaded Fidelius reference engine.
It must still pass the assigned ABDM interoperability, tamper, replay and
security-assessment test vectors before production use.
