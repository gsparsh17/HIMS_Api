const axios = require("axios");
const ICD = require("../models/icd11.model");

const delay = (ms) => new Promise(res => setTimeout(res, ms));
const visited = new Set();

// normalize helper
const normalize = (url) =>
  url ? url.replace("http://", "https://") : url;

const denormalize = (url) =>
  url ? url.replace("https://", "http://") : url;

async function fetchEntity(url, token) {
  if (!url) return;

  const cleanUrl = normalize(url);
  const altUrl = denormalize(cleanUrl); // 👈 for DB match

  if (visited.has(cleanUrl)) return;
  visited.add(cleanUrl);

  try {
    // ✅ CHECK BOTH http + https (NO DB CHANGE NEEDED)
    const existing = await ICD.findOne({
      $or: [
        { entityId: cleanUrl },
        { entityId: altUrl }
      ]
    });

    if (existing) {
      // 🔥 If already processed (has children), skip whole subtree
      if (existing.children && existing.children.length > 0) {
        return;
      }

      // ⚠️ If exists but no children → continue fetching
    }

    // 🔥 Fetch from API
    const res = await axios.get(cleanUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "API-Version": "v2",
        Accept: "application/json",
        "Accept-Language": "en"
      }
    });

    const data = res.data;

    // normalize everything BEFORE saving
    const entityId = normalize(data["@id"]);

    const parent = Array.isArray(data.parent)
      ? normalize(data.parent[0])
      : data.parent
      ? normalize(data.parent)
      : null;

    const children = (Array.isArray(data.child)
      ? data.child
      : data.child
      ? [data.child]
      : []
    ).map(normalize);

    const doc = {
      entityId,
      code: data.code || null,
      title: data.title?.["@value"] || "",
      definition: data.definition?.["@value"] || "",
      parent,
      children
    };

    // ✅ upsert using BOTH formats (important)
    await ICD.updateOne(
      {
        $or: [
          { entityId: entityId },
          { entityId: denormalize(entityId) }
        ]
      },
      { $set: doc },
      { upsert: true }
    );

    console.log(
      "Saved:",
      doc.code ? `${doc.code} - ${doc.title}` : entityId
    );

    // 🔥 traverse children
    for (const childUrl of children) {
      await delay(50);
      await fetchEntity(childUrl, token);
    }

  } catch (err) {
    console.error(
      "Error:",
      cleanUrl,
      err.response?.status,
      err.message
    );
  }
}

module.exports = fetchEntity;