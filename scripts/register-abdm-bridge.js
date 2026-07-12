require('dotenv').config({ path: __dirname + '/../.env' });
const { updateBridgeUrl, addHipService, getBridgeServices, getGatewayToken } = require('../services/abdm.service');

async function run() {
  console.log('--- ABDM Sandbox Registration Script ---');
  try {
    console.log('\n1. Verifying Gateway Token...');
    const token = await getGatewayToken();
    console.log(`✅ Token received: ${token.slice(0, 15)}...`);

    const bridgeUrl = 'https://api.mediqliq.com';
    console.log(`\n2. Updating Bridge URL to: ${bridgeUrl}`);
    try {
      const bridgeRes = await updateBridgeUrl(bridgeUrl);
      console.log('✅ Bridge URL Update Response:', bridgeRes);
    } catch (err) {
      if (err.details?.error?.code === 'ABDM-1094' || err.details?.error?.message?.includes('Duplicate')) {
        console.log('✅ Bridge URL already updated (Duplicate patch request). Moving on...');
      } else {
        throw err;
      }
    }

    console.log('\n✅ BRIDGE URL SETUP COMPLETED SUCCESSFULLY!');
    console.log('As per the new ABDM V3 guidelines, you must now link the bridge manually on the NHPR portal.');
  } catch (err) {
    console.error('\n❌ ERROR OCCURRED:');
    console.error(err.message);
    if (err.details) {
      console.error(JSON.stringify(err.details, null, 2));
    }
  }
}

run();
