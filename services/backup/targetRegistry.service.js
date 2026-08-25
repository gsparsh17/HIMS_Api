const localTarget = require('./targets/local.target');
const b2Target = require('./targets/b2.target');
const gdriveTarget = require('./targets/gdrive.target');
const { providers, requiredProviders } = require('./config');

const registry = new Map([
  ['local', localTarget],
  ['b2', b2Target],
  ['gdrive', gdriveTarget]
]);

function configuredTargets() {
  return providers().map((name) => {
    const target = registry.get(name);
    if (!target) throw new Error(`Unsupported backup storage provider: ${name}`);
    return target;
  });
}

async function distribute(filePath, context = {}) {
  const required = new Set(requiredProviders());
  const results = {};
  for (const target of configuredTargets()) {
    try {
      results[target.name] = await target.upload(filePath, context);
    } catch (error) {
      results[target.name] = { provider: target.name, success: false, error: error.message };
    }
  }
  const missingRequired = [...required].filter((name) => !results[name]?.success);
  return {
    results,
    required: [...required],
    success: missingRequired.length === 0,
    missingRequired
  };
}

module.exports = { configuredTargets, distribute };
