# MediQliq ABDM Crypto Adapter

This is one deployable image containing a hardened MediQliq API facade and the
uploaded Fidelius reference engine. The public contract inside the private
cluster is:

- `POST /v1/receiver-key-material`
- `POST /v1/encrypt`
- `POST /v1/decrypt`
- `GET /health`

The facade uses opaque AES-GCM authenticated key handles, so Hospital Backend
does not persist raw HIU private keys in production. It never logs plaintext
FHIR, private keys, session keys or nonces.

Build:

```bash
docker build -t mediqliq-abdm-crypto-adapter:1.0.0 .
```

Hospital Backend:

```env
ABDM_CRYPTO_MODE=external
ABDM_CRYPTO_ADAPTER_URL=http://mediqliq-crypto-adapter:8090
ABDM_CRYPTO_ADAPTER_HEALTH_URL=http://mediqliq-crypto-adapter:8090/health
ABDM_CRYPTO_ADAPTER_ALLOWED_HOSTS=mediqliq-crypto-adapter
ABDM_CRYPTO_ADAPTER_TOKEN=<same as MEDIQLIQ_SERVICE_TOKEN>
ABDM_REQUIRE_CRYPTO_INTEGRITY=true
```

Before certification, run the assigned ABDM cryptography interoperability and
tamper vectors against a reference HIP/HIU. The uploaded Fidelius project is a
reference implementation and still requires external security assessment.
