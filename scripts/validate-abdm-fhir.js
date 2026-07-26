const fs = require('fs');
const path = require('path');
const { validateBundle } = require('../services/abdmFhirValidation.service');

async function run() {
  const files = process.argv.slice(2);
  if (!files.length) {
    throw new Error('Usage: node scripts/validate-abdm-fhir.js <bundle.json> [...]');
  }
  let failed = 0;
  for (const value of files) {
    const file = path.resolve(value);
    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    // eslint-disable-next-line no-await-in-loop
    const result = await validateBundle(bundle);
    console.log(`${result.valid ? '✅' : '❌'} ${file}`);
    if (!result.valid) {
      failed += 1;
      console.log(JSON.stringify(result, null, 2));
    }
  }
  if (failed) process.exit(1);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
