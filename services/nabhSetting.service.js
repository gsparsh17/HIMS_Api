'use strict';

const NabhSetting = require('../models/NabhSetting');

async function getOrCreateNabhSetting(hospitalId, userId, { includeSecrets = false } = {}) {
  const buildQuery = () => {
    let query = NabhSetting.findOne({ hospitalId });
    if (includeSecrets) {
      query = query.select('+notifications.channels.apiKey +security.sso.assertionSecret');
    }
    return query;
  };

  let setting = await buildQuery();
  if (!setting) {
    try {
      setting = await NabhSetting.create({ hospitalId, updatedBy: userId });
    } catch (error) {
      // Concurrent first requests can both observe a missing settings document.
      // The unique hospital index decides the winner; the loser should simply
      // read the document rather than surfacing a duplicate-key failure.
      if (error?.code !== 11000) throw error;
      setting = await buildQuery();
    }
  }
  return setting;
}

module.exports = { getOrCreateNabhSetting };
