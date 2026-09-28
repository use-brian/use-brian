import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ consent: vi.fn(), hosts: [] as any[] }));
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.consent } }));
vi.mock('../embedded-browser-host.js', () => ({
  EmbeddedBrowserHost: class {
    entries: any[] = [];
    selected: number | null = null;
    show = vi.fn(); destroy = vi.fn(); setStatus = vi.fn();
    constructor(public partition: string, public callbacks: any) { mocks.hosts.push(this); }
    approveTab = vi.fn((id: number) => { const tab = this.entries.find(t => t.id === id); if (tab) tab.taskOwned = true; });
    tabs() { return this.entries; }
    selectedId() { return this.selected; }
    selectTab(id: number) { this.selected = id; }
    closeTab(id: number) { this.entries = this.entries.filter(t => t.id !== id); this.selected = this.entries[0]?.id ?? null; }
    async createTab(url: string, taskOwned: boolean) {
      const id = this.entries.length + 1;
      let attached = false;
      const contents = Object.assign(new EventEmitter(), {
        getURL: () => url, getTitle: () => 'Example', isDestroyed: () => false, isLoading: () => false,
        stop: vi.fn(), debugger: {
          isAttached: () => attached,
          attach: vi.fn(() => { attached = true; }), detach: vi.fn(() => { attached = false; }),
          sendCommand: vi.fn(async (_method: string, _params?: unknown): Promise<any> => ({})),
        },
      });
      this.entries.push({ id, handle: `tab-${id}`, taskOwned, contents });
      this.selected = id;
      return id;
    }
  },
}));
import { TabExecutor } from '@use-brian/browser-control/executor.js';
import { browserPairing, browserUrl, EmbeddedBrowser } from '../embedded-browser.js';

class Socket {
  static all: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { Socket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close = vi.fn(() => { this.readyState = 3; this.onclose?.({ code: 1000 }); });
  open() { this.readyState = 1; this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const claims = { kind: 'browser-ext-pair', exp: 4_000_000_000, userId: 'user', workspaceId: 'workspace', browserProfileId: 'profile' };
const input = (overrides = {}, relayUrl = 'wss://relay.example/browser') => ({ relayUrl, pairingToken: `header.${Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString('base64url')}.signature` });
let browser: EmbeddedBrowser;
let sequence = 0;
const host = () => mocks.hosts.at(-1)!;
const socket = () => Socket.all.at(-1)!;
async function connect() {
  const pending = browser.pair(input(), 'account');
  await flush(); socket().open(); socket().message({ type: 'ready', sessionToken: 'session-secret' });
  expect(await pending).toBe(true);
}
async function command(op: string, args: unknown = {}, controlMode = 'task_tabs') {
  const id = `command-${++sequence}`;
  socket().message({ type: 'command', id, op, args, controlMode });
  await flush();
  return socket().sent.find(m => m.type === 'result' && m.id === id);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket);
  Socket.all = []; mocks.hosts.length = 0; mocks.consent.mockReset().mockResolvedValue({ response: 1 });
  browser = new EmbeddedBrowser(); sequence = 0;
});
afterEach(() => { browser.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('pairing validation and storage isolation', () => {
  it('uses stable opaque partitions scoped to account, relay, user, workspace and profile', () => {
    const base = browserPairing(input(), 'account').partition;
    expect(base).toMatch(/^persist:embedded-browser-[a-f0-9]{64}$/);
    expect(browserPairing(input({ exp: claims.exp + 10 }), 'account').partition).toBe(base);
    const others = [browserPairing(input(), 'other'), browserPairing(input({}, 'wss://other.example/'), 'account'),
      ...['userId', 'workspaceId', 'browserProfileId'].map(key => browserPairing(input({ [key]: 'other' }), 'account'))];
    expect(new Set([base, ...others.map(p => p.partition)]).size).toBe(6);
  });
  it.each(['ws://remote.example', 'https://relay.example', 'wss://u:p@relay.example', 'wss://relay.example/#x', 'wss://relay.example/?token=x'])('rejects unsafe relay %s', url => {
    expect(() => browserPairing(input({}, url), 'account')).toThrow();
  });
  it.each(['ws://localhost:1234', 'ws://127.0.0.1:1234', 'ws://[::1]:1234'])('allows loopback %s', url => {
    expect(browserPairing(input({}, url), 'account').relayUrl).toContain(url);
  });
  it.each([{ exp: 0 }, { kind: 'session' }, { userId: '' }, { workspaceId: 4 }, { browserProfileId: 'x'.repeat(256) }])('rejects bad claims %j', overrides => {
    expect(() => browserPairing(input(overrides), 'account')).toThrow();
  });
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'https://u:p@example.com', 'not a url'])('rejects unsafe browser URL %s', url => {
    expect(() => browserUrl(url)).toThrow();
  });
  it('rejects oversized URLs', () => { expect(() => browserUrl('https://example.com/' + 'x'.repeat(16384))).toThrow(); });
  it('normalizes HTTP(S) URLs', () => { expect(browserUrl('https://EXAMPLE.com')).toBe('https://example.com/'); });
});

describe('native pairing lifecycle with the real RelayClient', () => {
  it('waits for relay ready, advertises Electron without protected-fill capabilities', async () => {
    let settled = false;
    const pending = browser.pair(input(), 'account').then(ok => { settled = true; return ok; });
    await flush();
    expect(mocks.hosts).toHaveLength(0); expect(settled).toBe(false);
    socket().open(); await flush();
    expect(socket().sent).toEqual([{ type: 'hello', pairingToken: input().pairingToken, clientKind: 'electron' }]);
    expect(settled).toBe(false);
    socket().message({ type: 'ready' }); expect(await pending).toBe(true);
    expect(host().partition).toBe(browserPairing(input(), 'account').partition);
    expect(host().show).toHaveBeenCalledOnce();
  });
  it('reports identity only for the active ready pairing', async () => {
    expect(browser.status()).toEqual({ connected: false });
    const pending = browser.pair(input(), 'account');
    expect(browser.status()).toEqual({ connected: false });
    await flush(); socket().open();
    expect(browser.status()).toEqual({ connected: false });
    socket().message({ type: 'ready' });
    expect(await pending).toBe(true);
    expect(browser.status()).toEqual({ connected: true, workspaceId: 'workspace', browserProfileId: 'profile' });
    const replacement = browser.pair(input({ workspaceId: 'next-workspace', browserProfileId: 'next-profile' }), 'account');
    expect(browser.status()).toEqual({ connected: false });
    await flush(); socket().open(); socket().message({ type: 'ready' });
    expect(await replacement).toBe(true);
    expect(browser.status()).toEqual({ connected: true, workspaceId: 'next-workspace', browserProfileId: 'next-profile' });
    browser.stop();
    expect(browser.status()).toEqual({ connected: false });
    await connect(); browser.dispose();
    expect(browser.status()).toEqual({ connected: false });
  });
  it('native refusal creates neither socket nor host', async () => {
    mocks.consent.mockResolvedValue({ response: 0 });
    expect(await browser.pair(input(), 'account')).toBe(false);
    expect(Socket.all).toHaveLength(0); expect(mocks.hosts).toHaveLength(0);
    expect(mocks.consent.mock.calls[0][0]).toMatchObject({ defaultId: 0, cancelId: 0 });
  });
  it('disposal during consent prevents a late approval and concurrent pairing', async () => {
    const consent = deferred<{ response: number }>(); mocks.consent.mockReturnValue(consent.promise);
    const pending = browser.pair(input(), 'account');
    expect(await browser.pair(input(), 'account')).toBe(false);
    browser.dispose(); consent.resolve({ response: 1 });
    expect(await pending).toBe(false); expect(Socket.all).toHaveLength(0);
  });
  it('disposal while ready is pending closes the socket and ignores late ready', async () => {
    const pending = browser.pair(input(), 'account'); await flush(); socket().open();
    browser.dispose(); socket().message({ type: 'ready' });
    expect(await pending).toBe(false); expect(socket().close).toHaveBeenCalled(); expect(mocks.hosts).toHaveLength(0);
  });
  it('times out ready and handles relay refusal without opening a host', async () => {
    const pending = browser.pair(input(), 'account'); await flush(); socket().open();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toBe(false); expect(socket().close).toHaveBeenCalled();
    const retry = browser.pair(input(), 'account'); await flush(); socket().open(); socket().message({ type: 'error', message: 'Unauthorized' });
    expect(await retry).toBe(false); expect(mocks.hosts).toHaveLength(0);
  });
  it.each([1006, 4000])('disconnect/replacement (%s) stops control without reconnecting', async code => {
    await connect(); await command('openTab', { url: 'https://example.com' });
    const wc = host().tabs()[0].contents;
    socket().drop(code); await vi.advanceTimersByTimeAsync(60000);
    expect(browser.status()).toEqual({ connected: false });
    expect(wc.stop).toHaveBeenCalled(); expect(wc.debugger.isAttached()).toBe(false);
    expect(Socket.all).toHaveLength(1); expect(host().destroy).not.toHaveBeenCalled();
    expect(host().setStatus).toHaveBeenLastCalledWith(expect.stringContaining('Manual browsing only'));
  });
});

describe('operations and revocation with the real TabExecutor', () => {
  it('returns protocol shapes for opening, listing, switching, reading and closing', async () => {
    await connect();
    expect(await command('openTab', { url: 'https://example.com' })).toMatchObject({ ok: true, data: { tabId: 'tab-1', url: 'https://example.com/', title: 'Example' } });
    expect(await command('listTabs')).toMatchObject({ data: { tabs: [{ id: 'tab-1', taskOwned: true, active: true }], activeTabId: 'tab-1' } });
    expect(await command('switchTab', { tabId: 'tab-1' })).toMatchObject({ data: { tabId: 'tab-1' } });
    expect(await command('currentUrl')).toMatchObject({ ok: true, data: { url: 'https://example.com/' } });
    expect(await command('closeTab', { tabId: 'tab-1' })).toMatchObject({ data: { closed: true, activeTabId: null } });
    expect(host().tabs()).toHaveLength(0);
  });
  it('returns real captureFrame and takeoverInput shapes through the CDP adapter', async () => {
    await connect(); await command('openTab', { url: 'https://example.com' });
    const send = host().tabs()[0].contents.debugger.sendCommand;
    send.mockImplementation(async (method: string) => method === 'Page.captureScreenshot' ? { data: 'jpeg-base64' } : {});
    expect(await command('captureFrame')).toMatchObject({ ok: true, data: { data: 'jpeg-base64', mimeType: 'image/jpeg' } });
    expect(send).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({ format: 'jpeg', captureBeyondViewport: false }));
    expect(await command('takeoverInput', { event: { kind: 'key', text: 'x' } })).toMatchObject({ ok: true, data: {} });
    expect(send).toHaveBeenCalledWith('Input.insertText', { text: 'x' });
  });
  // Executor internals have their own shared-package tests. These narrow spies check
  // controller argument/result translation while retaining real attach and relay paths.
  it.each([
    ['navigate', { url: 'https://EXAMPLE.com' }, ['https://example.com/'], { url: 'https://example.com/' }, { url: 'https://example.com/' }],
    ['snapshot', { mode: 'full' }, ['full'], { snapshot: 'tree' }, { snapshot: 'tree' }],
    ['snapshot', {}, ['interactive'], { snapshot: 'tree' }, { snapshot: 'tree' }],
    ['click', { ref: 'r1' }, ['r1'], undefined, {}],
    ['type', { ref: 'r1', text: 'hello' }, ['r1', 'hello'], undefined, {}],
    ['fillForm', { fields: [{ ref: 'r1', value: 'hello' }] }, [{ fields: [{ ref: 'r1', value: 'hello' }] }], { filled: 1 }, { filled: 1 }],
    ['captureState', { site: 'example.com' }, ['example.com'], { cookies: [], localStorage: {} }, { cookies: [], localStorage: {} }],
  ] as const)('preserves %s arguments and result shape', async (op, args, expectedArgs, result, data) => {
    await connect(); await command('openTab', { url: 'https://example.com' });
    const method = vi.spyOn(TabExecutor.prototype, op).mockResolvedValue(result as never);
    expect(await command(op, args)).toMatchObject({ ok: true, data });
    expect(method).toHaveBeenCalledExactlyOnceWith(...expectedArgs);
  });
  it('task_tabs excludes manual tabs, including selected tabs and handle-based operations', async () => {
    await connect(); await host().createTab('https://manual.example/', false);
    expect(await command('listTabs')).toMatchObject({ data: { tabs: [], activeTabId: null } });
    for (const op of ['switchTab', 'closeTab', 'currentUrl']) expect(await command(op, { tabId: 'tab-1' })).toMatchObject({ ok: false, code: 'no_eligible_tab' });
    expect(await command('navigate', { url: 'https://task.example/' })).toMatchObject({ ok: true, data: { url: 'https://task.example/' } });
    expect(host().tabs().map((t: any) => t.taskOwned)).toEqual([false, true]);
  });
  it('requires native consent before granting a manual tab through the host callback', async () => {
    await connect(); const id = await host().createTab('https://manual.example/', false);
    mocks.consent.mockResolvedValueOnce({ response: 0 });
    host().callbacks.approveTab(id); await flush();
    expect(mocks.consent).toHaveBeenLastCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0, buttons: ['Cancel', 'Allow tab'] }));
    expect(host().approveTab).not.toHaveBeenCalled();
    expect(await command('currentUrl', { tabId: 'tab-1' })).toMatchObject({ ok: false, code: 'no_eligible_tab' });
    host().callbacks.approveTab(id); await flush();
    expect(host().approveTab).toHaveBeenCalledExactlyOnceWith(id);
    expect(await command('currentUrl', { tabId: 'tab-1' })).toMatchObject({ ok: true, data: { url: 'https://manual.example/' } });
  });
  it('stop while manual-tab consent is pending blocks a late grant', async () => {
    await connect(); const id = await host().createTab('https://manual.example/', false);
    const consent = deferred<{ response: number }>(); mocks.consent.mockReturnValueOnce(consent.promise);
    host().callbacks.approveTab(id); await flush();
    expect(mocks.consent).toHaveBeenCalledTimes(2);
    browser.stop(); consent.resolve({ response: 1 }); await flush();
    expect(host().approveTab).not.toHaveBeenCalled();
    expect(host().tabs()[0].taskOwned).toBe(false);
    expect(browser.status()).toEqual({ connected: false });
  });
  it('full_browser needs native approval, denies safely, then remembers approval only for this session', async () => {
    await connect(); await host().createTab('https://manual.example/', false);
    mocks.consent.mockResolvedValueOnce({ response: 0 });
    expect(await command('listTabs', {}, 'full_browser')).toMatchObject({ ok: false, code: 'user_denied' });
    expect(await command('listTabs', {}, 'full_browser')).toMatchObject({ ok: true, data: { tabs: [{ taskOwned: false }] } });
    await command('currentUrl', {}, 'full_browser'); expect(mocks.consent).toHaveBeenCalledTimes(3);
    browser.stop(); await connect(); await command('listTabs', {}, 'full_browser');
    expect(mocks.consent).toHaveBeenCalledTimes(5);
  });
  it.each(['file:///secret', 'javascript:alert(1)', 'data:text/html,x', 'https://u:p@example.com'])('blocks unsafe URL %s across all navigation operations', async url => {
    await connect();
    expect(await command('openTab', { url })).toMatchObject({ ok: false });
    expect(await command('navigate', { url })).toMatchObject({ ok: false });
    expect(host().tabs()).toHaveLength(0);
    await command('openTab', { url: 'https://example.com' });
    const send = host().tabs()[0].contents.debugger.sendCommand; send.mockClear();
    expect(await command('navigate', { url })).toMatchObject({ ok: false });
    expect(await command('takeoverInput', { event: { kind: 'navigate', action: 'goto', url } })).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects unsupported/protected operations and malformed input', async () => {
    await connect();
    expect(await command('browserFillReference')).toMatchObject({ ok: false, code: 'protected_fill_denied' });
    expect(await command('arbitraryCDP')).toMatchObject({ ok: false, code: 'backend_error' });
    await command('openTab', { url: 'https://example.com' });
    for (const [op, args] of [['click', { ref: 42 }], ['type', { ref: 'x', text: false }], ['takeoverInput', { event: { kind: 'execute' } }]] as const) {
      expect(await command(op, args)).toMatchObject({ ok: false, code: 'backend_error' });
    }
  });
  it('requires separate consent for saved sign-in state', async () => {
    await connect(); await command('openTab', { url: 'https://example.com' });
    mocks.consent.mockResolvedValueOnce({ response: 0 });
    const send = host().tabs()[0].contents.debugger.sendCommand; send.mockClear();
    expect(await command('captureState', { site: 'example.com' })).toMatchObject({ ok: false, code: 'user_denied' });
    expect(send).not.toHaveBeenCalled();
  });
  it('stop bypasses queued work and fences an in-flight debugger response', async () => {
    await connect(); const pending = deferred<unknown>();
    await command('openTab', { url: 'https://example.com' });
    const wc = host().tabs()[0].contents;
    wc.debugger.sendCommand.mockImplementation(() => pending.promise);
    socket().message({ type: 'command', id: 'inflight', op: 'captureFrame', args: {} }); await flush();
    expect(wc.debugger.sendCommand).toHaveBeenLastCalledWith('Page.enable', undefined);
    socket().message({ type: 'command', id: 'queued', op: 'openTab', args: { url: 'https://queued.example' } });
    expect(await command('stop')).toMatchObject({ ok: true, data: { stopped: true } });
    const calls = wc.debugger.sendCommand.mock.calls.length;
    pending.resolve({ data: 'image' }); await flush();
    expect(host().tabs()).toHaveLength(1); expect(wc.debugger.sendCommand).toHaveBeenCalledTimes(calls);
    expect(wc.stop).toHaveBeenCalled(); expect(wc.debugger.isAttached()).toBe(false);
    expect(socket().sent.filter(m => ['inflight', 'queued'].includes(m.id))).toEqual([]);
    expect(socket().sent).toContainEqual({ type: 'event', kind: 'stopped' });
  });
  it('late full-browser approval cannot revive disposed control', async () => {
    await connect(); const consent = deferred<{ response: number }>(); mocks.consent.mockReturnValue(consent.promise);
    socket().message({ type: 'command', id: 'pending', op: 'openTab', args: { url: 'https://example.com' }, controlMode: 'full_browser' });
    await flush(); const oldHost = host(); browser.dispose(); consent.resolve({ response: 1 }); await flush();
    expect(oldHost.tabs()).toHaveLength(0); expect(oldHost.destroy).toHaveBeenCalledOnce();
    expect(socket().sent.find(m => m.id === 'pending')).toBeUndefined();
  });
});
