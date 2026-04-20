// getToken.js
const axios = require("axios");
const qs = require("qs");

async function getToken() {
  const res = await axios.post(
    "https://icdaccessmanagement.who.int/connect/token",
    qs.stringify({
      client_id: process.env.ClientId,
      client_secret: process.env.ClientSecret,
      grant_type: "client_credentials",
      scope: "icdapi_access"
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  return res.data.access_token;
}

module.exports = getToken;