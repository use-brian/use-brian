import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({ windows: [] as any[], views: [] as any[], sessions: new Map<string, any>() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const makeSession = () => Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  });
  let nextId = 1;
  class Contents extends EventEmitter {
    id = nextId++; url = ''; dead = false;
    mainFrame = { url: '' };
    session = makeSession();
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    getURL() { return this.url; } getTitle() { return 'Example'; } isDestroyed() { return this.dead; }
    loadURL = vi.fn(async (url: string) => { this.url = url; });
    close = vi.fn(() => { this.dead = true; this.emit('destroyed'); });
    send = vi.fn(); focus = vi.fn(); reload = vi.fn(); setWindowOpenHandler = vi.fn();
  }
  return {
    ipcMain: new EventEmitter(),
    session: {
      defaultSession: makeSession(),
      fromPartition: vi.fn((partition: string) => {
        if (!electronMocks.sessions.has(partition)) electronMocks.sessions.set(partition, makeSession());
        return electronMocks.sessions.get(partition);
      }),
    },
    BrowserWindow: class extends EventEmitter {
      webContents = new Contents();
      contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
      constructor(public options: any) { super(); electronMocks.windows.push(this); }
      loadFile = vi.fn(async (path: string) => { this.webContents.mainFrame.url = new URL(`file://${path}`).href; });
      getContentSize() { return [1200, 850]; } isDestroyed() { return false; }
      show = vi.fn(); focus = vi.fn(); destroy = vi.fn();
    },
    WebContentsView: class {
      webContents = new Contents();
      constructor(public options: any) { electronMocks.views.push(this); }
      setVisible = vi.fn(); setBounds = vi.fn();
    },
  };
});
import { ipcMain, session as electronSession } from 'electron';
import { EmbeddedBrowserHost } from '../embedded-browser-host.js';
let hosts: EmbeddedBrowserHost[];
let callbacks: { stop: ReturnType<typeof vi.fn>; closed: ReturnType<typeof vi.fn>; tabClosed: ReturnType<typeof vi.fn>; detached: ReturnType<typeof vi.fn> };
const create = (partition = 'persist:embedded-test') => { const h = new EmbeddedBrowserHost(partition, callbacks); hosts.push(h); return h; };
const win = () => electronMocks.windows.at(-1)!;
const wc = () => electronMocks.views.at(-1)!.webContents;
const event = () => ({ preventDefault: vi.fn() });
const ipc = (command: string, value?: unknown, overrides = {}) => {
  const toolbar = win().webContents;
  ipcMain.emit('embedded-browser:command', { sender: toolbar, senderFrame: toolbar.mainFrame, ...overrides }, command, value);
};
beforeEach(() => {
  hosts = []; electronMocks.windows.length = 0; electronMocks.views.length = 0; electronMocks.sessions.clear();
  callbacks = { stop: vi.fn(), closed: vi.fn(), tabClosed: vi.fn(), detached: vi.fn() };
});
afterEach(() => { for (const h of hosts) h.destroy(); });

describe('embedded browser host isolation and native boundaries', () => {
  it.each(['', 'default', 'persist:', 'persist:deployment-production'])('rejects unsafe partition %s', partition => {
    expect(() => create(partition)).toThrow(); expect(electronMocks.windows).toHaveLength(0);
  });
  it('rejects shared/default sessions and releases exclusive ownership on destroy', () => {
    const h = create(); expect(() => create()).toThrow('already in use');
    h.destroy(); expect(() => create()).not.toThrow();
    electronMocks.sessions.set('persist:default-alias', electronSession.defaultSession);
    expect(() => create('persist:default-alias')).toThrow('already in use');
  });
  it('isolates toolbar and site contexts with sandboxing and no site preload', async () => {
    const h = create(); await h.createTab('https://example.com', true);
    const toolbar = win().options.webPreferences;
    const site = electronMocks.views[0].options.webPreferences;
    expect(toolbar).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false });
    expect(toolbar.partition).toMatch(/^embedded-toolbar-/); expect(toolbar.partition).not.toContain('persist:');
    expect(site).toMatchObject({ session: electronMocks.sessions.get('persist:embedded-test'), sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, disableDialogs: true });
    expect(site).not.toHaveProperty('preload');
    expect(site.session).not.toBe(win().webContents.session);
  });
  it('denies permissions, device access and downloads', () => {
    create();
    for (const s of [electronMocks.sessions.get('persist:embedded-test'), win().webContents.session]) {
      const reply = vi.fn(); s.setPermissionRequestHandler.mock.calls[0][0]({}, 'camera', reply);
      expect(reply).toHaveBeenCalledWith(false);
      expect(s.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
      expect(s.setDevicePermissionHandler.mock.calls[0][0]()).toBe(false);
    }
    const download = event(); electronMocks.sessions.get('persist:embedded-test').emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'about:blank', 'custom:launch', 'https://user:pass@example.com'])('blocks unsafe creation, navigation, redirect and popup %s', async url => {
    const h = create(); await expect(h.createTab(url, true)).rejects.toThrow(); expect(electronMocks.views).toHaveLength(0);
    await h.createTab('https://example.com', true);
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      const e = { ...event(), url }; wc().emit(name, e, url); expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    expect(wc().setWindowOpenHandler.mock.calls[0][0]({ url })).toEqual({ action: 'deny' });
    expect(h.tabs()).toHaveLength(1);
    ipc('navigate', url); expect(wc().loadURL).toHaveBeenCalledTimes(1);
  });
  it('denies local/custom subresources while allowing HTTP and in-memory media only outside frames', () => {
    create(); const intercept = electronMocks.sessions.get('persist:embedded-test').webRequest.onBeforeRequest.mock.calls[0][0];
    for (const resourceType of ['mainFrame', 'subFrame', 'image', 'xhr']) {
      for (const url of ['https://example.com', 'http://example.com', 'file:///secret', 'custom:launch', 'data:image/png,x', 'blob:https://example.com/id', 'wss://example.com/socket']) {
        const reply = vi.fn(); intercept({ resourceType, url }, reply);
        const allowed = /^https?:/.test(url) || (!['mainFrame', 'subFrame'].includes(resourceType) && /^(data:|blob:|wss:)/.test(url));
        expect(reply, `${resourceType}: ${url}`).toHaveBeenCalledWith({ cancel: !allowed });
      }
    }
  });
  it.each([true, false])('denies GET and POST popups without recreating them (taskOwned=%s)', async taskOwned => {
    const h = create(); const id = await h.createTab('https://example.com', taskOwned);
    const popup = wc().setWindowOpenHandler.mock.calls[0][0];
    for (const postBody of [undefined, { data: [{ bytes: Buffer.from('secret=value') }] }]) {
      expect(popup({ url: 'https://popup.example/', postBody })).toEqual({ action: 'deny' });
      expect(h.tabs()).toHaveLength(1);
      expect(h.selectedId()).toBe(id);
      expect(electronMocks.views).toHaveLength(1);
      expect(wc().loadURL).toHaveBeenCalledTimes(1);
      expect(win().webContents.send.mock.lastCall[1].status).toMatch(/Popup blocked\. Open .* manually.*sign-in may not work/);
    }
  });
  it('requests approval only from trusted IPC and never grants it implicitly', async () => {
    const approveTab = vi.fn(); Object.assign(callbacks, { approveTab });
    const h = create();
    ipc('approve'); expect(approveTab).not.toHaveBeenCalled();
    const id = await h.createTab('https://example.com', false);
    ipc('approve', undefined, { sender: wc() });
    ipc('approve', undefined, { senderFrame: { url: win().webContents.mainFrame.url } });
    const frame = win().webContents.mainFrame; const trustedUrl = frame.url;
    frame.url = 'https://attacker.example/'; ipc('approve'); frame.url = trustedUrl;
    expect(approveTab).not.toHaveBeenCalled();
    ipc('approve', id + 100); // Payload cannot choose a different tab.
    expect(approveTab).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.tabs()[0].taskOwned).toBe(false);
    h.approveTab(id);
    expect(h.tabs()[0].taskOwned).toBe(true);
    expect(win().webContents.send.mock.lastCall[1].tabs[0]).toMatchObject({ id, taskOwned: true });
    ipc('approve'); expect(approveTab).toHaveBeenCalledTimes(1);
    h.closeTab(id); h.approveTab(id); h.approveTab(-1);
    expect(h.tabs()).toEqual([]);
    h.destroy(); expect(() => h.approveTab(id)).not.toThrow();
  });
  it('keeps approval optional and contains callback failures without granting access', async () => {
    const h = create(); await h.createTab('https://example.com', false);
    ipc('approve'); expect(h.tabs()[0].taskOwned).toBe(false);
    Object.assign(callbacks, { approveTab: () => { throw new Error('denied'); } });
    expect(() => ipc('approve')).not.toThrow();
    expect(h.tabs()[0].taskOwned).toBe(false);
    expect(win().webContents.send.mock.lastCall[1].status).toBe('Browser callback failed');
  });
  it('accepts IPC only from the exact toolbar main frame and URL', async () => {
    const h = create(); await h.createTab('https://example.com', true);
    ipc('stop', undefined, { sender: wc() });
    ipc('stop', undefined, { senderFrame: { url: win().webContents.mainFrame.url } });
    const frame = win().webContents.mainFrame; const trustedUrl = frame.url;
    frame.url = 'https://attacker.example/'; ipc('stop'); frame.url = trustedUrl;
    expect(callbacks.stop).not.toHaveBeenCalled();
    ipc('stop'); expect(callbacks.stop).toHaveBeenCalledOnce();
    ipc('new'); expect(h.tabs().at(-1)?.taskOwned).toBe(false);
  });
  it('locks toolbar navigation and native popups', () => {
    create(); const toolbar = win().webContents;
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const e = event(); toolbar.emit(name, e, 'https://example.com'); expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    expect(toolbar.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.com' })).toEqual({ action: 'deny' });
  });
  it('notifies close/crash and disposes IPC, download listeners and site contents idempotently', async () => {
    const h = create(); await h.createTab('https://example.com', true); const contents = wc();
    contents.emit('render-process-gone'); expect(callbacks.detached).toHaveBeenCalledWith(contents.id);
    h.closeTab(contents.id); expect(callbacks.tabClosed).toHaveBeenCalledExactlyOnceWith(contents.id);
    await h.createTab('https://second.example', false); const second = wc();
    h.destroy(); h.destroy(); ipc('stop');
    expect(second.close).toHaveBeenCalledExactlyOnceWith({ waitForBeforeUnload: false });
    expect(ipcMain.listenerCount('embedded-browser:command')).toBe(0);
    expect(electronMocks.sessions.get('persist:embedded-test').listenerCount('will-download')).toBe(0);
    expect(callbacks.stop).not.toHaveBeenCalled(); expect(win().destroy).toHaveBeenCalledOnce();
    await expect(h.createTab('https://example.com', false)).rejects.toThrow('closed');
  });
});


describe('trusted toolbar approval control', () => {
  it('starts disabled, reflects selected ownership, and sends only an approval request', () => {
    const html = readFileSync(new URL('../embedded-browser.html', import.meta.url), 'utf8');
    expect(html).toContain('<button id="approve" disabled>Allow Brian on this tab</button>');
    const elements = new Map<string, any>();
    const makeElement = () => ({
      disabled: false, value: '', addEventListener: vi.fn(), replaceChildren: vi.fn(),
      setAttribute: vi.fn(), append: vi.fn(),
    });
    const document = {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement: makeElement,
    };
    const ipcRenderer = { send: vi.fn(), on: vi.fn() };
    const window = { addEventListener: vi.fn() };
    runInNewContext(readFileSync(new URL('../embedded-browser-preload.cjs', import.meta.url), 'utf8'), {
      require: () => ({ ipcRenderer }), window, document,
    });
    window.addEventListener.mock.calls.find(([name]) => name === 'DOMContentLoaded')![1]();
    const update = ipcRenderer.on.mock.calls.find(([name]) => name === 'embedded-browser:state')![1];
    const approve = elements.get('approve');
    update({}, { tabs: [], selected: null, status: '' });
    expect(approve.disabled).toBe(true);
    update({}, { tabs: [{ id: 1, taskOwned: false }], selected: 1, status: '' });
    expect(approve.disabled).toBe(false);
    approve.addEventListener.mock.calls.find(([name]: [string]) => name === 'click')[1]();
    expect(ipcRenderer.send).toHaveBeenLastCalledWith('embedded-browser:command', 'approve', undefined);
    update({}, { tabs: [{ id: 1, taskOwned: true }], selected: 1, status: '' });
    expect(approve.disabled).toBe(true);
    update({}, { tabs: [{ id: 1, taskOwned: false }], selected: 2, status: '' });
    expect(approve.disabled).toBe(true);
  });
});
