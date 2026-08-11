const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function source(path) {
  return fs.readFileSync(require.resolve(path), 'utf8');
}

const config = source('../config/abdm.config');
const fhir = source('../services/abdmFhirValidation.service');
const cryptoAdapter = source('../services/abdmCryptoAdapter.service');
const consent = source('../services/abdmConsentValidation.service');
const hiu = source('../services/abdmHiuHospital.service');
const transfer = source('../services/abdmDataTransfer.service');
const dataFlow = source('../services/abdmDataFlow.service');


test('FHIR, Crypto and Consent have independent master/local provider configuration', () => {
  assert.ok(config.includes("providerEnv('ABDM_FHIR_PROVIDER', 'master')"));
  assert.ok(config.includes("providerEnv('ABDM_CONSENT_PROVIDER', 'master')"));
  assert.ok(config.includes("'ABDM_CRYPTO_PROVIDER'"));
  assert.ok(config.includes("ABDM_FHIR_FALLBACK_PROVIDER"));
});


test('Hospital wrappers retain both Master shared routes and local service paths', () => {
  assert.ok(fhir.includes('/internal/abdm/shared/fhir/validate'));
  assert.ok(fhir.includes('abdmConfig.fhirValidatorUrl'));
  assert.ok(cryptoAdapter.includes('/internal/abdm/shared/crypto/encrypt'));
  assert.ok(cryptoAdapter.includes('abdmConfig.cryptoAdapterUrl'));
  assert.ok(consent.includes('/internal/abdm/shared/consent/validate'));
  assert.ok(consent.includes('abdmConfig.consentValidatorUrl'));
  assert.ok(dataFlow.includes('encryptHealthInformation(input)'));
});


test('FHIR fallback is availability-only and explicit', () => {
  assert.ok(fhir.includes('providerUnavailable(error)'));
  assert.ok(fhir.includes("fallbackProvider !== 'none'"));
  assert.ok(fhir.includes('providerConfigured(fallbackProvider)'));
});


test('Crypto receiver key material persists provider affinity for later decryption', () => {
  assert.ok(cryptoAdapter.includes('return { ...result, provider }'));
  assert.ok(hiu.includes('{ provider: receiver.provider, keyHandle: receiver.keyHandle }'));
  assert.ok(hiu.includes('provider: privateMaterial?.provider'));
});


test('Consent usage reservations persist provider affinity across commit/release retries', () => {
  assert.ok(consent.includes('usage: accepted.usage ? { ...accepted.usage, provider } : null'));
  assert.ok(consent.includes('reservationOrUsage.provider'));
  assert.ok(hiu.includes('commitConsentUsage(consentAuthorization.usage)'));
  assert.ok(transfer.includes('commitConsentUsage(pendingUsage)'));
  assert.ok(transfer.includes('releaseConsentUsage(usage)'));
});


test('production crypto cannot use mock provider', () => {
  assert.ok(config.includes("ABDM_CRYPTO_PROVIDER=mock is forbidden in production"));
});
