require("dotenv").config();

const axios = require("axios");
const connectDB = require("../config/db");
const getToken = require("../utils/getToken");
const fetchEntity = require("../utils/fetchICD");

async function getRoot(token) {
  const res = await axios.get(
    "https://id.who.int/icd/release/11/mms",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "API-Version": "v2",
        Accept: "application/json",
        "Accept-Language": "en"
      }
    }
  );

  return res.data;
}

async function main() {
  try {
    await connectDB();

    const token = await getToken();
    console.log("✅ Token received");

    const root = await getRoot(token);
    console.log("Root keys:", Object.keys(root));

    if (!root.release || !root.release.length) {
      console.error("❌ No release versions found");
      process.exit(1);
    }

    const releaseUrl = root.release[0];
    console.log("📦 Using release:", releaseUrl);

    const releaseRes = await axios.get(
      releaseUrl.replace("http://", "https://"),
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "API-Version": "v2",
          Accept: "application/json",
          "Accept-Language": "en"
        }
      }
    );

    const releaseData = releaseRes.data;

    const topNodes = Array.isArray(releaseData.child)
      ? releaseData.child
      : releaseData.child
      ? [releaseData.child]
      : [];

    if (!topNodes.length) {
      console.error("❌ No top-level ICD nodes found");
      process.exit(1);
    }

    console.log(`🚀 Starting from ${topNodes.length} top-level nodes`);

    for (const child of topNodes) {
      await fetchEntity(child, token);
    }

    console.log("✅ ICD-11 import completed");
    process.exit(0);

  } catch (err) {
    console.error("Fatal:", err.response?.data || err.message);
    process.exit(1);
  }
}

main();