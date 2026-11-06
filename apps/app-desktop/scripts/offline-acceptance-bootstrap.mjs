/** Local packaged-app fault harness. [COMP:app-desktop/offline-restart]
 * Copy to dist only for the unsigned acceptance package. Never a release entry.
 * Uses a separate profile and the local rig session; no production credentials.
 */
import { app, session, safeStorage, powerMonitor } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const profile = process.env.BRIAN_OFFLINE_TEST_PROFILE;
if (!profile || !profile.startsWith('/tmp/')) throw new Error('Acceptance requires an isolated /tmp profile');
app.setName('Use Brian Offline Acceptance');
app.setPath('userData', profile);
mkdirSync(profile, { recursive: true });
process.env.USEBRIAN_DISABLE_AUTO_UPDATE = '1';
process.env.USEBRIAN_BUNDLED = '1';
delete process.env.USEBRIAN_APP_URL;
delete process.env.USEBRIAN_API_URL;
const offline = () => process.env.BRIAN_OFFLINE_TEST_OFFLINE === '1' || existsSync(join(profile, 'offline'));
const configure = jar => {
  jar.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: offline() || !['127.0.0.1', 'localhost'].includes(url.hostname) });
  });
};
app.on('session-created', configure);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (offline() || !['127.0.0.1', 'localhost'].includes(url.hostname)) return Promise.reject(new TypeError('Acceptance network unavailable'));
  return realFetch(input, init);
};
void app.whenReady().then(async () => {
configure(session.defaultSession);
if (!existsSync(join(profile, 'target.json'))) {
  const path = process.env.BRIAN_OFFLINE_TEST_SESSION;
  if (!path) throw new Error('First start requires the local rig session path');
  const auth = JSON.parse(readFileSync(path, 'utf8'));
  const config = await realFetch('http://127.0.0.1:3003/api/desktop-config').then(r => r.json());
  writeFileSync(join(profile, 'target.json'), JSON.stringify({ v: 1, kind: 'local', appUrl: 'http://127.0.0.1:3003', apiUrl: 'http://127.0.0.1:4100', auth: 'local-session', publicConfig: config.publicConfig ?? config }), { mode: 0o600 });
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS credential encryption unavailable');
  writeFileSync(join(profile, 'tokens.bin'), safeStorage.encryptString(JSON.stringify({ accessToken: auth.accessToken, refreshToken: auth.refreshToken,
    accessTokenExpiresAt: Date.now() + auth.accessTokenExpiresIn * 1000, user: auth.user })), { mode: 0o600 });
}
await import('./bootstrap.js');
if (offline()) setTimeout(() => powerMonitor.emit('resume'), 10_000);
}).catch(error => { console.error(error); app.exit(1); });
