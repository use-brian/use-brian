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
    loadFile = vi.fn(async (path: string) => { this.mainFrame.url = new URL(`file://${path}`).href; });
    setZoomFactor = vi.fn(); setVisualZoomLevelLimits = vi.fn(async () => {});
    focused = false; isFocused() { return this.focused; }
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
    BaseWindow: class extends EventEmitter {
      webContents = new Contents();
      contentView = Object.assign(new EventEmitter(), { addChildView: vi.fn(), removeChildView: vi.fn() });
      constructor(public options: any) { super(); electronMocks.windows.push(this); }
      loadFile = vi.fn(async (path: string) => { this.webContents.mainFrame.url = new URL(`file://${path}`).href; });
      size = [1200, 850]; dead = false;
      getContentSize() { return this.size; } isDestroyed() { return this.dead; }
      show = vi.fn(); hide = vi.fn(); focus = vi.fn(); destroy = vi.fn(() => { this.dead = true; });
    },
    WebContentsView: class {
      webContents = new Contents();
      constructor(public options: any) { electronMocks.views.push(this); }
      setVisible = vi.fn(); setBounds = vi.fn();
    },
  };
});
import { BaseWindow, type BrowserWindow, ipcMain, session as electronSession } from 'electron';
import { EmbeddedBrowserHost } from '../embedded-browser-host.js';
let hosts: EmbeddedBrowserHost[];
let callbacks: { stop: ReturnType<typeof vi.fn>; closed: ReturnType<typeof vi.fn>; tabClosed: ReturnType<typeof vi.fn>; detached: ReturnType<typeof vi.fn> };
const create = (partition = 'persist:embedded-test') => { const h = new EmbeddedBrowserHost(partition, callbacks); hosts.push(h); return h; };
const win = () => electronMocks.windows.at(-1)!;
const toolbar = () => electronMocks.views[0].webContents;
const wc = () => electronMocks.views.at(-1)!.webContents;
const event = () => ({ preventDefault: vi.fn() });
const ipc = (command: string, value?: unknown, overrides = {}) => {
  const trusted = toolbar();
  ipcMain.emit('embedded-browser:command', { sender: trusted, senderFrame: trusted.mainFrame, ...overrides }, command, value);
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
    const toolbarOptions = electronMocks.views[0].options.webPreferences;
    const site = electronMocks.views[1].options.webPreferences;
    expect(toolbarOptions).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false });
    expect(toolbarOptions.partition).toMatch(/^embedded-toolbar-/); expect(toolbarOptions.partition).not.toContain('persist:');
    expect(site).toMatchObject({ session: electronMocks.sessions.get('persist:embedded-test'), sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, disableDialogs: true });
    expect(site).not.toHaveProperty('preload');
    expect(site.session).not.toBe(toolbar().session);
  });
  it('denies permissions, device access and downloads', () => {
    create();
    for (const s of [electronMocks.sessions.get('persist:embedded-test'), toolbar().session]) {
      const reply = vi.fn(); s.setPermissionRequestHandler.mock.calls[0][0]({}, 'camera', reply);
      expect(reply).toHaveBeenCalledWith(false);
      expect(s.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
      expect(s.setDevicePermissionHandler.mock.calls[0][0]()).toBe(false);
    }
    const download = event(); electronMocks.sessions.get('persist:embedded-test').emit('will-download', download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'about:blank', 'custom:launch', 'https://user:pass@example.com'])('blocks unsafe creation, navigation, redirect and popup %s', async url => {
    const h = create(); await expect(h.createTab(url, true)).rejects.toThrow(); expect(electronMocks.views).toHaveLength(1);
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
      expect(electronMocks.views).toHaveLength(2);
      expect(wc().loadURL).toHaveBeenCalledTimes(1);
      expect(toolbar().send.mock.lastCall[1].status).toMatch(/Popup blocked\. Open .* manually.*sign-in may not work/);
    }
  });
  it('requests approval only from trusted IPC and never grants it implicitly', async () => {
    const approveTab = vi.fn(); Object.assign(callbacks, { approveTab });
    const h = create();
    ipc('approve'); expect(approveTab).not.toHaveBeenCalled();
    const id = await h.createTab('https://example.com', false);
    ipc('approve', undefined, { sender: wc() });
    ipc('approve', undefined, { senderFrame: { url: toolbar().mainFrame.url } });
    const frame = toolbar().mainFrame; const trustedUrl = frame.url;
    frame.url = 'https://attacker.example/'; ipc('approve'); frame.url = trustedUrl;
    expect(approveTab).not.toHaveBeenCalled();
    ipc('approve', id + 100); // Payload cannot choose a different tab.
    expect(approveTab).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.tabs()[0].taskOwned).toBe(false);
    h.approveTab(id);
    expect(h.tabs()[0].taskOwned).toBe(true);
    expect(toolbar().send.mock.lastCall[1].tabs[0]).toMatchObject({ id, taskOwned: true });
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
    expect(toolbar().send.mock.lastCall[1].status).toBe('Browser callback failed');
  });
  it('accepts IPC only from the exact toolbar main frame and URL', async () => {
    const h = create(); await h.createTab('https://example.com', true);
    ipc('stop', undefined, { sender: wc() });
    ipc('stop', undefined, { senderFrame: { url: toolbar().mainFrame.url } });
    const frame = toolbar().mainFrame; const trustedUrl = frame.url;
    frame.url = 'https://attacker.example/'; ipc('stop'); frame.url = trustedUrl;
    expect(callbacks.stop).not.toHaveBeenCalled();
    ipc('stop'); expect(callbacks.stop).toHaveBeenCalledOnce();
    ipc('new'); expect(h.tabs().at(-1)?.taskOwned).toBe(false);
  });
  it('locks toolbar navigation and native popups', () => {
    create(); const trusted = toolbar();
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const e = event(); trusted.emit(name, e, 'https://example.com'); expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    expect(trusted.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.com' })).toEqual({ action: 'deny' });
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


describe('docked view ownership and layout', () => {
  const setup = () => {
    const main = new BaseWindow({}) as any;
    const h = new EmbeddedBrowserHost('persist:docked-test', callbacks, { dockWindow: main as BrowserWindow });
    hosts.push(h);
    return { h, main };
  };
  it('lazily detaches and redocks identical live views without navigating or closing', async () => {
    const { h, main } = setup();
    const id = await h.createTab('https://example.com', true);
    const original = h.tabs()[0]; const contents = wc(); const trusted = toolbar();
    expect(electronMocks.windows).toHaveLength(1);
    ipc('detach');
    const detached = win();
    expect(detached).not.toBe(main);
    expect(main.contentView.removeChildView).toHaveBeenCalledWith(electronMocks.views[0]);
    expect(detached.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(main.webContents.send).toHaveBeenLastCalledWith('embedded-browser:dock-layout', { reservedWidth: 0, contentWidth: 1200 });
    const close = event(); detached.emit('close', close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(detached.hide).toHaveBeenCalledOnce();
    expect(h.tabs()[0]).toEqual(original); expect(h.selectedId()).toBe(id);
    expect(contents.loadURL).toHaveBeenCalledTimes(1); expect(trusted.loadFile).toHaveBeenCalledTimes(1);
    expect(contents.close).not.toHaveBeenCalled(); expect(trusted.close).not.toHaveBeenCalled();
    expect(callbacks.closed).not.toHaveBeenCalled();
    h.destroy(); expect(main.destroy).not.toHaveBeenCalled(); expect(detached.destroy).toHaveBeenCalledOnce();
    expect(trusted.close).toHaveBeenCalledOnce(); expect(contents.close).toHaveBeenCalledOnce();
  });
  it('reserves right-hand DIP geometry, clamps validated resize and remembers expansion', async () => {
    const { h, main } = setup(); await h.createTab('https://example.com', false);
    const view = electronMocks.views[1];
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 728, y: 176, width: 472, height: 674 });
    ipc('resize', { width: 9999 });
    expect(main.webContents.send.mock.lastCall[1].reservedWidth).toBe(560);
    for (const payload of [{ width: NaN }, { width: Infinity }, { width: '400' }, { width: 400, extra: true }, 400]) ipc('resize', payload);
    expect(main.webContents.send.mock.lastCall[1].reservedWidth).toBe(560);
    main.size = [900, 700]; main.emit('resize');
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(main.webContents.send.mock.lastCall[1].reservedWidth).toBe(56);
    wc().focus.mockClear(); h.selectTab(h.selectedId()!); expect(wc().focus).not.toHaveBeenCalled();
    main.size = [1400, 850]; main.emit('resize');
    expect(main.webContents.send.mock.lastCall[1].reservedWidth).toBe(560);
    ipc('collapse'); main.emit('resize'); expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.setBounds.mock.lastCall[0].width).toBe(552); // hidden page is not rail-width
    ipc('expand'); expect(view.setVisible).toHaveBeenLastCalledWith(true);
    ipc('resize', { width: -1 }); expect(main.webContents.send.mock.lastCall[1].reservedWidth).toBe(360);
    main.webContents.send.mockClear(); main.webContents.emit('dom-ready'); main.webContents.emit('did-finish-load');
    expect(main.webContents.send).toHaveBeenCalledTimes(2);
    expect(toolbar().setZoomFactor).toHaveBeenCalledWith(1);
    expect(toolbar().setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1);
    // Programmatic native content changes may precede/omit a window resize event.
    main.size = [800, 650]; main.contentView.emit('bounds-changed');
    expect(main.webContents.send.mock.lastCall[1]).toEqual({ reservedWidth: 56, contentWidth: 800 });
  });
  it.each([false, true])('main close disposes in either mode (detached=%s) and cleans listeners', async detached => {
    const { h, main } = setup(); await h.createTab('https://example.com', false);
    if (detached) ipc('detach');
    const contents = main.webContents, contentView = main.contentView;
    for (const [key, value] of [['webContents', contents], ['contentView', contentView]]) {
      Object.defineProperty(main, key, { get() { if (main.dead) throw new Error('Native window destroyed'); return value; } });
    }
    main.dead = true; main.emit('closed'); main.emit('closed');
    expect(callbacks.closed).toHaveBeenCalledOnce(); expect(wc().close).toHaveBeenCalledOnce();
    expect(toolbar().close).toHaveBeenCalledOnce(); expect(main.destroy).not.toHaveBeenCalled();
    expect(main.listenerCount('resize')).toBe(0); expect(main.listenerCount('closed')).toBe(0);
    expect(contents.listenerCount('dom-ready')).toBe(0);
    expect(contents.listenerCount('did-finish-load')).toBe(0);
    expect(contentView.listenerCount('bounds-changed')).toBe(0);
    expect(h.tabs()).toEqual([]);
  });
  it('uses actual visible contents focus and never reports detached focus', async () => {
    const { h } = setup(); await h.createTab('https://example.com', false);
    expect(h.isDockedFocused()).toBe(false); wc().focused = true; expect(h.isDockedFocused()).toBe(true);
    ipc('collapse'); expect(h.isDockedFocused()).toBe(false);
    toolbar().focused = true; expect(h.isDockedFocused()).toBe(true);
    ipc('detach'); expect(h.isDockedFocused()).toBe(false);
    h.focusBrowser(); expect(wc().focus).toHaveBeenCalled();
  });
  it('closing a standalone detached window disposes and notifies once', () => {
    create(); const detached = win(); detached.emit('close', event()); detached.emit('close', event());
    expect(callbacks.closed).toHaveBeenCalledOnce(); expect(toolbar().close).toHaveBeenCalledOnce();
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
      setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn(),
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
    update({}, { tabs: [], selected: null, status: '', presentation: {
      mode: 'docked', collapsed: false, panelWidth: 480, minWidth: 360, maxWidth: 700,
    } });
    const separator = elements.get('separator');
    const fire = (name: string, event: any) => separator.addEventListener.mock.calls.find(([type]: [string]) => type === name)[1](event);
    fire('pointerdown', { button: 0, pointerId: 1, screenX: 800, preventDefault: vi.fn() });
    fire('pointermove', { pointerId: 1, screenX: 750 });
    expect(ipcRenderer.send).toHaveBeenLastCalledWith('embedded-browser:command', 'resize', { width: 530 });
    fire('pointercancel', {});
    expect(separator.releasePointerCapture).toHaveBeenCalledWith(1);
    ipcRenderer.send.mockClear(); fire('pointermove', { pointerId: 1, screenX: 700 });
    expect(ipcRenderer.send).not.toHaveBeenCalled();
    for (const [key, width] of [['ArrowLeft', 496], ['ArrowRight', 464], ['Home', 360], ['End', 700]]) {
      fire('keydown', { key, preventDefault: vi.fn() });
      expect(ipcRenderer.send).toHaveBeenLastCalledWith('embedded-browser:command', 'resize', { width });
    }
    update({}, { tabs: [], selected: null, status: '', presentation: {
      mode: 'docked', collapsed: true, panelWidth: 56, minWidth: 360, maxWidth: 700,
    } });
    expect(elements.get('rail').hidden).toBe(false);
    expect(elements.get('controls').hidden).toBe(true);
    elements.get('rail-stop').addEventListener.mock.calls[0][1]();
    expect(ipcRenderer.send).toHaveBeenLastCalledWith('embedded-browser:command', 'stop', undefined);
  });
});
