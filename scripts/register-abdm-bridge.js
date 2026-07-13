/**
 * V3 bridge bootstrap helper.
 *
 * This script intentionally does NOT call the legacy
 * /gateway/v1/bridges/addUpdateServices endpoint. Facility registration and
 * software linkage must be completed through the current NHPR/HFR sandbox flow.
 */
require('dotenv').config({ path: `${__dirname}/../.env` });
const abdmConfig = require('../config/abdm.config');
const { getGatewayToken } = require('../services/abdmAuth.service');
const { updateBridgeUrl, getBridgeServices } = require('../services/abdmHttp.service');

async function run() {
  console.log('--- MediQliq ABDM V3 Bridge Bootstrap ---');
  try {
    abdmConfig.assertMasterCredentials();
    const bridgeUrl = abdmConfig.publicBaseUrl;
    if (!bridgeUrl) throw new Error('ABDM_PUBLIC_BASE_URL is required');

    console.log(`Environment: ${abdmConfig.environment}`);
    console.log(`Bridge ID: ${abdmConfig.bridgeId || '(not configured)'}`);

    console.log('\n1. Verifying V3 gateway authentication...');
    const token = await getGatewayToken();
    console.log(`✅ Gateway token received: ${token.slice(0, 10)}...`);

    console.log(`\n2. Updating V3 bridge URL to ${bridgeUrl} ...`);
    const bridgeResponse = await updateBridgeUrl(bridgeUrl);
    console.log('✅ Bridge URL request accepted:', JSON.stringify(bridgeResponse, null, 2));

    console.log('\n3. Reading bridge services, if available...');
    try {
      const services = await getBridgeServices();
      console.log(JSON.stringify(services, null, 2));
    } catch (error) {
      console.warn(`⚠️ Service lookup was not completed: ${error.message}`);
    }

    console.log('\n✅ Software bridge bootstrap completed.');
    console.log('NEXT EXTERNAL STEP: Register/approve the hospital in NHPR/HFR and complete Software Linkage with this Bridge ID.');
    console.log('Do not use the legacy V1 addUpdateServices facility-registration flow.');
  } catch (error) {
    console.error('\n❌ ABDM V3 bridge bootstrap failed:');
    console.error(error.message);
    if (error.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
  }
}

run();
