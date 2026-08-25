const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const { googleFolderName } = require('../config');

const CREDENTIALS_PATH = path.resolve(process.env.GDRIVE_OAUTH_CREDENTIALS_PATH || path.join(process.cwd(), 'oauth-credentials.json'));
const TOKEN_PATH = path.resolve(process.env.GDRIVE_OAUTH_TOKEN_PATH || path.join(process.cwd(), 'token.json'));

async function getOAuthClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Google Drive OAuth credentials not found: ${CREDENTIALS_PATH}`);
  }
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const source = credentials.installed || credentials.web;
    if (!source) throw new Error('Invalid Google OAuth credentials file');
    const client = new google.auth.OAuth2(source.client_id, source.client_secret, source.redirect_uris?.[0]);
    client.setCredentials(token);
    return client;
  }

  if (String(process.env.GDRIVE_ALLOW_INTERACTIVE_AUTH || 'false').toLowerCase() !== 'true') {
    throw new Error('Google Drive token is missing. Generate token.json first or set GDRIVE_ALLOW_INTERACTIVE_AUTH=true for a one-time interactive setup.');
  }
  const auth = await authenticate({
    keyfilePath: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(auth.credentials));
  return auth;
}

async function ensureFolder(drive, name, parentId = null) {
  const escaped = String(name).replace(/'/g, "\\'");
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const result = await drive.files.list({
    q: `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`,
    fields: 'files(id,name)'
  });
  if (result.data.files?.length) return result.data.files[0].id;
  const created = await drive.files.create({
    resource: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    },
    fields: 'id'
  });
  return created.data.id;
}

async function upload(filePath, context = {}) {
  const auth = await getOAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  const date = context.completedAt || new Date();
  const hospitalFolder = await ensureFolder(drive, googleFolderName());
  const typeFolder = await ensureFolder(drive, context.type || 'backup', hospitalFolder);
  const yearFolder = await ensureFolder(drive, String(date.getUTCFullYear()), typeFolder);
  const monthFolder = await ensureFolder(drive, `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`, yearFolder);
  const response = await drive.files.create({
    resource: { name: context.fileName || path.basename(filePath), parents: [monthFolder] },
    media: { mimeType: 'application/zip', body: fs.createReadStream(filePath) },
    fields: 'id,webViewLink,size'
  });
  return {
    provider: 'gdrive',
    success: true,
    location: response.data.webViewLink || response.data.id,
    fileId: response.data.id,
    bytes: Number(response.data.size || fs.statSync(filePath).size)
  };
}

module.exports = { name: 'gdrive', upload };
