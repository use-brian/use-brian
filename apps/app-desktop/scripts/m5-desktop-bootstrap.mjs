/** M5 packaged-desktop qualification entry. Test harness only, never a release entry.
 * [COMP:app-desktop/offline-restart]
 *
 * Packaged only into an unsigned qualification copy (electron-builder
 * `extraMetadata.main=scripts/m5-desktop-bootstrap.mjs`, a distinct appId and no
 * `protocols`), importing the unchanged `dist/bootstrap.js`. It keeps
 * the qualification run away from the person's installed app and data:
 *   - userData is the throwaway M5_DESKTOP_PROFILE (must contain "m5-desktop-qual");
 *   - safeStorage uses Chromium's mock keychain, so no login-keychain item is made;
 *   - the copy never claims the usebrian:// scheme, global hotkeys or a login item;
 *   - every non-loopback request is refused (no cloud traffic);
 *   - native dialogs are still shown, but their title and message are logged first
 *     (a synchronous modal blocks the main process and the driver).
 * First start (no target.json) seeds only the local target, as the Self-hosted
 * dialog would persist it, without credentials: the shell's own local-owner mint
 * (ensureBundledLocalSession) performs sign-in.
 * Env: M5_DESKTOP_PROFILE, M5_DESKTOP_APP_URL, M5_DESKTOP_API_URL.
 */
import { app, dialog, globalShortcut, session } from 'electron';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const profile = process.env.M5_DESKTOP_PROFILE;
if (!profile || !profile.includes('m5-desktop-qual')) throw new Error('Qualification requires a throwaway m5-desktop-qual profile');
app.setName('Use Brian M5 Qualification');
app.setPath('userData', profile);
mkdirSync(profile, { recursive: true });
app.commandLine.appendSwitch('use-mock-keychain');
process.env.USEBRIAN_DISABLE_AUTO_UPDATE = '1';
process.env.USEBRIAN_BUNDLED = '1';
delete process.env.USEBRIAN_APP_URL;
delete process.env.USEBRIAN_API_URL;

// No OS-wide registration from a qualification copy.
app.setAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => {};
globalShortcut.register = () => false;

for (const name of ['showErrorBox', 'showMessageBox', 'showMessageBoxSync']) {
  const original = dialog[name].bind(dialog);
  dialog[name] = (...args) => {
    const opts = args.find((a) => a && typeof a === 'object' && ('message' in a || 'title' in a));
    const text = name === 'showErrorBox' ? { title: args[0], message: args[1] } : { title: opts?.title, message: opts?.message, detail: opts?.detail, buttons: opts?.buttons };
    console.log(`[m5-dialog] ${name} ${JSON.stringify(text)} at ${new Error().stack?.split('\n').slice(2, 6).join(' <- ')}`);
    return original(...args);
  };
}

// Window lifecycle trace for the identity-change journeys (observation only).
app.on('browser-window-created', (_e, w) => {
  const id = w.id;
  const tag = () => { try { return w.webContents.getURL().replace(/\?.*?(#|$)/, '?…$1').slice(-70); } catch { return ''; } };
  w.on('close', () => console.log(`[m5-window] close ${id} ${tag()} t=${Date.now()}`));
  w.on('closed', () => console.log(`[m5-window] closed ${id} t=${Date.now()}`));
  w.webContents.on('will-prevent-unload', () => console.log(`[m5-window] will-prevent-unload ${id} t=${Date.now()}`));
});

const loopback = (raw) => {
  try { return ['127.0.0.1', 'localhost'].includes(new URL(raw).hostname); } catch { return false; }
};
const guard = (jar) => {
  jar.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    callback({ cancel: !loopback(details.url) });
  });
};
app.on('session-created', guard);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!loopback(url)) return Promise.reject(new TypeError('Qualification network is loopback only'));
  return realFetch(input, init);
};

void app.whenReady().then(async () => {
  guard(session.defaultSession);
  const targetFile = join(profile, 'target.json');
  if (!existsSync(targetFile)) {
    const appUrl = process.env.M5_DESKTOP_APP_URL;
    const apiUrl = process.env.M5_DESKTOP_API_URL;
    if (!appUrl || !apiUrl) throw new Error('First start requires M5_DESKTOP_APP_URL and M5_DESKTOP_API_URL');
    const config = await realFetch(`${appUrl}/api/desktop-config`).then((r) => r.json());
    writeFileSync(targetFile, JSON.stringify({ v: 1, kind: 'local', appUrl, apiUrl, auth: 'local-session', publicConfig: config.publicConfig ?? config }), { mode: 0o600 });
  }
  await import('../dist/bootstrap.js');
}).catch((error) => { console.error(error); app.exit(1); });
