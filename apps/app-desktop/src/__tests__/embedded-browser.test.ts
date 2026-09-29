import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ consent: vi.fn(), hosts: [] as any[] }));
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.consent } }));
vi.mock('../embedded-browser-host.js', () => ({
  EmbeddedBrowserHost: class {
    entries: any[] = [];
    selected: number | null = null;
    show = vi.fn(); destroy = vi.fn(); setStatus = vi.fn();
    isDockedFocused = vi.fn(() => false);
    constructor(public partition: string, public callbacks: any, public options?: { dockWindow?: BrowserWindow | null }) { mocks.hosts.push(this); }
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
let approvals: { has: ReturnType<typeof vi.fn>; grant: ReturnType<typeof vi.fn> };
const identity = { workspaceId: 'workspace', browserProfileId: 'profile' };
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
  const controlEpoch = socket().sent.filter(m => m.type === 'event' && m.kind === 'stopped').at(-1)?.controlEpoch;
  socket().message({ type: 'command', id, op, args, controlMode, controlEpoch });
  await flush();
  return socket().sent.find(m => m.type === 'result' && m.id === id);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket);
  Socket.all = []; mocks.hosts.length = 0; mocks.consent.mockReset().mockResolvedValue({ response: 1 });
  const grants = new Set<string>();
  approvals = { has: vi.fn((key: string) => grants.has(key)), grant: vi.fn((key: string) => { grants.add(key); }) };
  browser = new EmbeddedBrowser({ approvals }); sequence = 0;
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
  it('resolves the injected dock window only after consent and relay ready', async () => {
    const dockWindow = {} as BrowserWindow;
    const getDockWindow = vi.fn(() => dockWindow);
    browser = new EmbeddedBrowser({ getDockWindow, approvals });
    const consent = deferred<{ response: number }>();
    mocks.consent.mockReturnValueOnce(consent.promise);
    const pending = browser.pair(input(), 'account');
    await flush();
    expect(getDockWindow).not.toHaveBeenCalled();
    expect(Socket.all).toHaveLength(0);
    expect(mocks.hosts).toHaveLength(0);
    consent.resolve({ response: 1 });
    await flush(); socket().open(); await flush();
    expect(getDockWindow).not.toHaveBeenCalled();
    expect(mocks.hosts).toHaveLength(0);
    socket().message({ type: 'ready' });
    expect(await pending).toBe(true);
    expect(getDockWindow).toHaveBeenCalledExactlyOnceWith();
    expect(host().options?.dockWindow).toBe(dockWindow);
    expect(host().show).toHaveBeenCalledOnce();
  });
  it('delegates dock focus to the live host and returns false without one', async () => {
    expect(browser.isDockedFocused()).toBe(false);
    await connect();
    const current = host();
    expect(browser.isDockedFocused()).toBe(false);
    current.isDockedFocused.mockReturnValue(true);
    expect(browser.isDockedFocused()).toBe(true);
    expect(current.isDockedFocused).toHaveBeenCalledTimes(2);
    browser.dispose();
    expect(browser.isDockedFocused()).toBe(false);
    expect(current.isDockedFocused).toHaveBeenCalledTimes(2);
  });
  it.each(['stop', 'dispose', 'cancelPending'] as const)('%s during pending consent or ready never resolves a dock or creates a late host', async action => {
    const getDockWindow = vi.fn(() => ({} as BrowserWindow));
    browser = new EmbeddedBrowser({ getDockWindow, approvals });
    const consent = deferred<{ response: number }>();
    mocks.consent.mockReturnValueOnce(consent.promise);
    const consenting = browser.pair(input(), 'account');
    browser[action](); consent.resolve({ response: 1 });
    expect(await consenting).toBe(false);
    expect(Socket.all).toHaveLength(0);
    const pending = browser.pair(input(), 'account');
    await flush(); socket().open();
    const oldSocket = socket();
    browser[action]();
    expect(await pending).toBe(false);
    oldSocket.message({ type: 'ready' }); await flush();
    expect(oldSocket.close).toHaveBeenCalled();
    expect(getDockWindow).not.toHaveBeenCalled();
    expect(mocks.hosts).toHaveLength(0);
    expect(browser.status()).toEqual(action === 'stop'
      ? { controlEpoch: 4, connected: false, automaticBlocked: true, ...identity }
      : { controlEpoch: 4, connected: false, automaticBlocked: false });
  });
  it('reports pending identity, retains it after Stop, and clears it on disposal', async () => {
    expect(browser.status()).toEqual({ controlEpoch: 0, connected: false, automaticBlocked: false });
    const pending = browser.pair(input(), 'account');
    expect(browser.status()).toEqual({ controlEpoch: 1, connected: false, automaticBlocked: false, ...identity });
    await flush(); socket().open(); socket().message({ type: 'ready' });
    expect(await pending).toBe(true);
    expect(browser.status()).toEqual({ controlEpoch: 1, connected: true, automaticBlocked: false, ...identity });
    browser.stop();
    expect(browser.status()).toEqual({ controlEpoch: 2, connected: false, automaticBlocked: true, ...identity });
    await connect(); browser.dispose();
    expect(browser.status()).toEqual({ controlEpoch: 4, connected: false, automaticBlocked: false });
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
    expect(browser.status()).toEqual({ controlEpoch: 2, connected: false, automaticBlocked: code === 4000, ...identity });
    expect(wc.stop).toHaveBeenCalled(); expect(wc.debugger.isAttached()).toBe(false);
    expect(Socket.all).toHaveLength(1); expect(host().destroy).toHaveBeenCalledOnce();
  });
});

describe('standing approval and automatic lifecycle', () => {
  const automatic = (overrides = {}, relay?: string) => ({ ...input(overrides, relay), automatic: true });
  async function ready(pending: Promise<boolean>) {
    await flush(); socket().open(); socket().message({ type: 'ready' });
    expect(await pending).toBe(true);
  }
  it('reuses injected approvals across instances and token renewal, but not manual tab grants', async () => {
    await connect();
    expect(approvals.grant).toHaveBeenCalledExactlyOnceWith(browserPairing(input(), 'account').partition);
    browser.dispose(); browser = new EmbeddedBrowser({ approvals });
    await ready(browser.pair(automatic({ exp: claims.exp + 10 }), 'account'));
    expect(mocks.consent).toHaveBeenCalledOnce();
    const id = await host().createTab('https://manual.example/', false);
    host().callbacks.approveTab(id); await flush();
    expect(mocks.consent).toHaveBeenCalledTimes(2);
  });
  it.each(['account', 'relay', 'userId', 'workspaceId', 'browserProfileId'])('requires fresh consent for a different %s', async dimension => {
    await connect(); browser.dispose(); browser = new EmbeddedBrowser({ approvals });
    const next = automatic(['userId', 'workspaceId', 'browserProfileId'].includes(dimension) ? { [dimension]: 'other' } : {},
      dimension === 'relay' ? 'wss://other.example/browser' : undefined);
    await ready(browser.pair(next, dimension === 'account' ? 'other-account' : 'account'));
    expect(mocks.consent).toHaveBeenCalledTimes(2);
    expect(new Set(approvals.grant.mock.calls.map(([key]) => key)).size).toBe(2);
  });
  it('denial blocks repeated automatic attempts until explicit resume', async () => {
    mocks.consent.mockResolvedValueOnce({ response: 0 });
    expect(await browser.pair(automatic(), 'account')).toBe(false);
    for (let i = 0; i < 3; i++) expect(await browser.pair(automatic(), 'account')).toBe(false);
    expect(browser.status()).toEqual({ controlEpoch: 1, connected: false, automaticBlocked: true, ...identity });
    expect(mocks.consent).toHaveBeenCalledOnce();
    expect(approvals.grant).not.toHaveBeenCalled();
    expect(Socket.all).toHaveLength(0); expect(mocks.hosts).toHaveLength(0);
    await connect();
    expect(browser.status().automaticBlocked).toBe(false);
  });
  it('automatic pairing cannot replace an active host, even for another profile', async () => {
    await connect(); const activeHost = host(); const activeSocket = socket();
    for (const profile of ['profile', 'other']) expect(await browser.pair(automatic({ browserProfileId: profile }), 'account')).toBe(false);
    expect(activeHost.destroy).not.toHaveBeenCalled(); expect(activeSocket.close).not.toHaveBeenCalled();
    expect(mocks.hosts).toHaveLength(1); expect(Socket.all).toHaveLength(1);
    expect(mocks.consent).toHaveBeenCalledOnce();
    expect(browser.status()).toEqual({ controlEpoch: 1, connected: true, automaticBlocked: false, ...identity });
  });
  it('explicit pairing can replace the active profile and updates pending identity', async () => {
    await connect(); const previousHost = host(); const previousSocket = socket();
    const pending = browser.pair(input({ workspaceId: 'next-workspace', browserProfileId: 'next-profile' }), 'account');
    expect(previousHost.destroy).toHaveBeenCalledOnce(); expect(previousSocket.close).toHaveBeenCalledOnce();
    expect(browser.status()).toEqual({ controlEpoch: 2, connected: false, automaticBlocked: false, workspaceId: 'next-workspace', browserProfileId: 'next-profile' });
    await ready(pending);
    expect(browser.status()).toEqual({ controlEpoch: 2, connected: true, automaticBlocked: false, workspaceId: 'next-workspace', browserProfileId: 'next-profile' });
  });
  it('disposal clears the denial latch so a new automatic session asks again', async () => {
    mocks.consent.mockResolvedValueOnce({ response: 0 });
    expect(await browser.pair(automatic(), 'account')).toBe(false);
    browser.dispose();
    expect(browser.status()).toEqual({ controlEpoch: 2, connected: false, automaticBlocked: false });
    await ready(browser.pair(automatic(), 'account'));
    expect(mocks.consent).toHaveBeenCalledTimes(2);
  });
  it('Stop destroys the browser and blocks repeated automatic pairs until explicit resume', async () => {
    await connect(); const stoppedHost = host(); browser.stop();
    for (let i = 0; i < 3; i++) expect(await browser.pair(automatic(), 'account')).toBe(false);
    expect(browser.status()).toEqual({ controlEpoch: 2, connected: false, automaticBlocked: true, ...identity });
    expect(stoppedHost.destroy).toHaveBeenCalledOnce(); expect(Socket.all).toHaveLength(1);
    await connect();
    expect(stoppedHost.destroy).toHaveBeenCalledOnce();
    expect(mocks.consent).toHaveBeenCalledOnce();
    expect(browser.status()).toEqual({ controlEpoch: 3, connected: true, automaticBlocked: false, ...identity });
  });
  it.each(['during minting', 'immediately before pair'])('rejects explicit Resume after a newer Stop %s without recreating the closed host', async timing => {
    await connect(); browser.stop();
    const pausedHost = host();
    const expectedControlEpoch = browser.status().controlEpoch;
    expect(expectedControlEpoch).toBe(2);
    const minted = deferred<ReturnType<typeof input>>();
    const resume = async () => {
      const credentials = await minted.promise;
      if (timing === 'immediately before pair') browser.stop();
      return browser.pair({ ...credentials, expectedControlEpoch }, 'account');
    };
    const pending = resume();
    if (timing === 'during minting') browser.stop();
    minted.resolve(input({ browserProfileId: 'replacement' }));
    const dispose = vi.spyOn(browser, 'dispose');
    expect(await pending).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    expect(browser.status()).toEqual({ connected: false, automaticBlocked: true, controlEpoch: 3, ...identity });
    expect(pausedHost.destroy).toHaveBeenCalledOnce();
    expect(Socket.all).toHaveLength(1); expect(mocks.hosts).toHaveLength(1);
    expect(mocks.consent).toHaveBeenCalledOnce();
    expect(await browser.pair(automatic({ browserProfileId: 'replacement' }), 'account')).toBe(false);
    expect(browser.status()).toEqual({ connected: false, automaticBlocked: true, controlEpoch: 3, ...identity });
  });
  it('accepts explicit Resume at the same control epoch and clears the Stop latch', async () => {
    await connect(); browser.stop();
    const pausedHost = host();
    expect(browser.status()).toEqual({ connected: false, automaticBlocked: true, controlEpoch: 2, ...identity });
    const expectedControlEpoch = browser.status().controlEpoch;
    await ready(browser.pair({ ...input(), expectedControlEpoch }, 'account'));
    expect(browser.status()).toEqual({ connected: true, automaticBlocked: false, controlEpoch: 3, ...identity });
    expect(pausedHost.destroy).toHaveBeenCalledOnce();
    expect(Socket.all).toHaveLength(2); expect(mocks.hosts).toHaveLength(2);
    expect(mocks.consent).toHaveBeenCalledOnce();
  });
  it('disconnect disposal clears identity but retains Stop across profiles until ordinary disposal', async () => {
    await connect(); browser.stop();
    const pausedHost = host();
    expect(browser.status()).toEqual({ connected: false, automaticBlocked: true, controlEpoch: 2, ...identity });
    browser.dispose(true);
    expect(browser.status()).toEqual({ connected: false, automaticBlocked: true, controlEpoch: 3 });
    expect(pausedHost.destroy).toHaveBeenCalledOnce();
    expect(await browser.pair(automatic({ browserProfileId: 'other' }), 'account')).toBe(false);
    expect(browser.status()).toEqual({ connected: false, automaticBlocked: true, controlEpoch: 3 });
    expect(Socket.all).toHaveLength(1); expect(mocks.hosts).toHaveLength(1);
    expect(mocks.consent).toHaveBeenCalledOnce();
    browser.dispose();
    expect(browser.status()).toEqual({ connected: false, automaticBlocked: false, controlEpoch: 4 });
    await ready(browser.pair(automatic({ browserProfileId: 'other' }), 'account'));
    expect(browser.status()).toEqual({ connected: true, automaticBlocked: false, controlEpoch: 5,
      workspaceId: 'workspace', browserProfileId: 'other' });
    expect(mocks.consent).toHaveBeenCalledTimes(2);
  });
  it('cancelPending leaves active control intact and show delegates only to a live host', async () => {
    browser.show(); browser.cancelPending(); await connect();
    const activeHost = host(); activeHost.show.mockClear();
    browser.cancelPending(); browser.show();
    expect(activeHost.show).toHaveBeenCalledOnce(); expect(activeHost.destroy).not.toHaveBeenCalled();
    expect(socket().close).not.toHaveBeenCalled(); expect(browser.status().connected).toBe(true);
    browser.dispose(); browser.show(); expect(activeHost.show).toHaveBeenCalledOnce();
  });
  it('does not persist consent before ready, or after cancelled consent', async () => {
    const consent = deferred<{ response: number }>(); mocks.consent.mockReturnValueOnce(consent.promise);
    const pending = browser.pair(automatic(), 'account'); browser.cancelPending(); consent.resolve({ response: 1 });
    expect(await pending).toBe(false); expect(approvals.grant).not.toHaveBeenCalled();
    const retry = browser.pair(automatic(), 'account'); await flush(); socket().open();
    expect(approvals.grant).not.toHaveBeenCalled(); browser.cancelPending();
    expect(await retry).toBe(false); socket().message({ type: 'ready' }); await flush();
    expect(approvals.grant).not.toHaveBeenCalled(); expect(mocks.hosts).toHaveLength(0);
  });
});

describe('browser shutdown and restart', () => {
  it('toolbar Stop closes the host, keeps only the relay, and show starts an empty browser', async () => {
    await connect();
    await command('openTab', { url: 'https://task.example/' });
    await host().createTab('https://manual.example/', false);
    const previous = host();
    previous.callbacks.stop();
    expect(previous.destroy).toHaveBeenCalledOnce();
    expect(browser.isDockedFocused()).toBe(false);
    expect(browser.status()).toMatchObject({ connected: false, automaticBlocked: true });
    expect(socket().close).not.toHaveBeenCalled();
    expect(await browser.pair({ ...input(), automatic: true }, 'account')).toBe(false);
    expect(mocks.hosts).toHaveLength(1);
    browser.show();
    expect(mocks.hosts).toHaveLength(2);
    expect(host().partition).toBe(previous.partition);
    expect(host().tabs()).toEqual([]);
    expect(browser.status()).toMatchObject({ connected: true, automaticBlocked: false });
    expect(mocks.consent).toHaveBeenCalledOnce();
    expect(await command('openTab', { url: 'https://new.example/' })).toMatchObject({ ok: true });
  });
  it.each(['navigate', 'openTab'])('Brian can restart with %s, but reads, clicks and invalid URLs cannot', async op => {
    await connect();
    expect(await command('stop')).toMatchObject({ ok: true });
    expect(host().destroy).toHaveBeenCalledOnce();
    for (const followup of ['snapshot', 'click', 'listTabs']) {
      expect(await command(followup)).toMatchObject({ ok: false, code: 'user_stopped' });
    }
    expect(await command(op, { url: 'file:///secret' })).toMatchObject({ ok: false });
    expect(mocks.hosts).toHaveLength(1);
    expect(await command(op, { url: 'https://new.example/' })).toMatchObject({ ok: true });
    expect(mocks.hosts).toHaveLength(2);
    expect(host().tabs()).toHaveLength(1);
    expect(browser.status()).toMatchObject({ connected: true, automaticBlocked: false });
    expect(Socket.all).toHaveLength(1);
    expect(mocks.consent).toHaveBeenCalledOnce();
  });
  it('rejects pre-Stop commands still in transit, including after a fresh restart', async () => {
    await connect();
    const oldHost = host();
    oldHost.callbacks.stop();
    socket().message({ type: 'command', id: 'late-start', op: 'navigate', args: { url: 'https://stale.example/' } });
    await flush();
    expect(mocks.hosts).toHaveLength(1);
    expect(socket().sent).toContainEqual(expect.objectContaining({ id: 'late-start', ok: false, code: 'user_stopped' }));
    expect(await command('navigate', { url: 'https://new.example/' })).toMatchObject({ ok: true });
    const freshHost = host();
    socket().message({ type: 'command', id: 'late-input', op: 'type', args: { ref: 'a', text: 'stale' } });
    oldHost.callbacks.detached(freshHost.tabs()[0].id);
    oldHost.callbacks.closed();
    oldHost.callbacks.stop();
    await flush();
    expect(socket().sent).toContainEqual(expect.objectContaining({ id: 'late-input', ok: false, code: 'user_stopped' }));
    expect(freshHost.destroy).not.toHaveBeenCalled();
    expect(browser.status().connected).toBe(true);
    freshHost.callbacks.stop();
    socket().message({ type: 'command', id: 'older-epoch', op: 'openTab', args: { url: 'https://stale.example/' }, controlEpoch: 2 });
    await flush();
    expect(mocks.hosts).toHaveLength(2);
    expect(await command('navigate', { url: 'https://latest.example/' })).toMatchObject({ ok: true });
  });
  it.each(['dispose', 'disconnect', 'replacement'])('%s discards the dormant restart capability', async action => {
    await connect(); host().callbacks.stop();
    if (action === 'dispose') browser.dispose();
    else socket().drop(action === 'replacement' ? 4000 : 1006);
    browser.show();
    await command('openTab', { url: 'https://late.example/' });
    expect(mocks.hosts).toHaveLength(1);
    expect(browser.status().connected).toBe(false);
  });
  it('new navigation is not blocked by an old unresolved debugger command', async () => {
    await connect(); await command('openTab', { url: 'https://old.example/' });
    const pending = deferred<unknown>();
    host().tabs()[0].contents.debugger.sendCommand.mockImplementation(() => pending.promise);
    socket().message({ type: 'command', id: 'old', op: 'captureFrame', args: {} });
    await flush();
    socket().message({ type: 'command', id: 'queued', op: 'openTab', args: { url: 'https://queued.example/' } });
    host().callbacks.stop();
    expect(await command('navigate', { url: 'https://new.example/' })).toMatchObject({ ok: true });
    pending.resolve({}); await flush();
    expect(host().tabs()).toHaveLength(1);
    expect(socket().sent.filter(m => ['old', 'queued'].includes(m.id))).toEqual([]);
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
    expect(browser.status()).toEqual({ controlEpoch: 2, connected: false, automaticBlocked: true, ...identity });
  });
  it('full_browser needs native approval, denies safely, then remembers approval only for this session', async () => {
    await connect(); await host().createTab('https://manual.example/', false);
    mocks.consent.mockResolvedValueOnce({ response: 0 });
    expect(await command('listTabs', {}, 'full_browser')).toMatchObject({ ok: false, code: 'user_denied' });
    expect(await command('listTabs', {}, 'full_browser')).toMatchObject({ ok: true, data: { tabs: [{ taskOwned: false }] } });
    await command('currentUrl', {}, 'full_browser'); expect(mocks.consent).toHaveBeenCalledTimes(3);
    browser.stop(); await connect(); await command('listTabs', {}, 'full_browser');
    expect(mocks.consent).toHaveBeenCalledTimes(4);
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
    expect(socket().sent).toContainEqual({ type: 'event', kind: 'stopped', controlEpoch: 2 });
  });
  it('late full-browser approval cannot revive disposed control', async () => {
    await connect(); const consent = deferred<{ response: number }>(); mocks.consent.mockReturnValue(consent.promise);
    socket().message({ type: 'command', id: 'pending', op: 'openTab', args: { url: 'https://example.com' }, controlMode: 'full_browser' });
    await flush(); const oldHost = host(); browser.dispose(); consent.resolve({ response: 1 }); await flush();
    expect(oldHost.tabs()).toHaveLength(0); expect(oldHost.destroy).toHaveBeenCalledOnce();
    expect(socket().sent.find(m => m.id === 'pending')).toBeUndefined();
  });
});
