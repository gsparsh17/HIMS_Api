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

    console.log('\n3. Adding HIP Service (CITY_HOSPITAL_HIP)...');
    const hipRes = await addHipService(bridgeUrl);
    console.log('✅ HIP Service Addition Response:', hipRes);

    console.log('\n4. Verifying Services (getServices)...');
    const servicesRes = await getBridgeServices();
    console.log('✅ Verified Services:');
    console.log(JSON.stringify(servicesRes, null, 2));

    console.log('\n✅ ALL STEPS COMPLETED SUCCESSFULLY!');
    console.log('You can now copy the output above and reply to the ABDM support email.');
  } catch (err) {
    console.error('\n❌ ERROR OCCURRED:');
    console.error(err.message);
    if (err.details) {
      console.error(JSON.stringify(err.details, null, 2));
    }
  }
}

run();
