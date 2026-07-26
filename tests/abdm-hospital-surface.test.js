const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const connectorSource = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'abdmConnector.routes.js'),
  'utf8'
);

test('hospital app does not mount master or public ABDM callback routes', () => {
  assert.equal(appSource.includes("/api/abdm/master"), false);
  assert.equal(appSource.includes("/api/mediqliq"), false);
  assert.equal(appSource.includes("app.use('/api/v3'"), false);
  assert.equal(appSource.includes('mountMasterRoutes'), false);
});

test('hospital connector includes M2 and M3 callback surfaces', () => {
  for (const route of [
    '/profile-share',
    '/discover',
    '/consent/notify',
    '/health-information/request',
    '/hiu/consent/notify',
    '/hiu/health-information/on-request',
    '/hiu/data'
  ]) {
    assert.ok(connectorSource.includes(route), `Missing ${route}`);
  }
});
