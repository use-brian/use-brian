import { describe, it, expect, vi, afterEach } from 'vitest'
import { BrowserRelay, LIVENESS_WINDOW_MS, type RelaySocket } from '../relay.js'
import { relaySecretMatches } from '../auth.js'
import {
  signBrowserExtPairToken,
  signBrowserExtSessionToken,
  verifyBrowserExtHelloToken,
  verifyBrowserExtPairToken,
  verifyBrowserExtSessionToken,
} from '@use-brian/api/auth/browser-ext-pair-token.js'
import { CURRENT_EXTENSION_BUILD } from '@use-brian/api/sandbox/extension-build.js'

const SECRET = 'test-jwt-secret'
const PROFILE = 'profile-1'

type FakeSocket = RelaySocket & {
  sent: Array<Record<string, unknown>>
  closed: { code?: number; reason?: string } | null
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closed: null,
    send(data: unknown) {
      socket.sent.push(JSON.parse(String(data)) as Record<string, unknown>)
    },
    close(code?: number, reason?: string) {
      socket.closed = { code, reason }
    },
  } as FakeSocket
  return socket
}

function relayWithVerifier(commandTimeoutMs?: number): BrowserRelay {
  return new BrowserRelay({
    authorize: () => true,
    verifyPairingToken: (token) => {
      const payload = verifyBrowserExtPairToken(token, SECRET)
      return payload
        ? {
            userId: payload.userId,
            workspaceId: payload.workspaceId,
            browserProfileId: payload.browserProfileId,
          }
        : null
    },
    commandTimeoutMs,
  })
}

/**
 * Defaults to the CURRENT build, so the rest of the suite describes a healthy
 * install. Pass `build: null` to describe an extension that predates build
 * stamping — which the relay treats as stale, on purpose.
 */
function pair(
  relay: BrowserRelay,
  userId = 'user-1',
  build: string | null = CURRENT_EXTENSION_BUILD,
  browserProfileId = PROFILE,
): FakeSocket {
  const socket = fakeSocket()
  const token = signBrowserExtPairToken({ userId, workspaceId: 'ws-1', browserProfileId }, SECRET)
  relay.handleMessage(
    socket,
    JSON.stringify({ type: 'hello', pairingToken: token, ...(build ? { build } : {}) }),
  )
  return socket
}

afterEach(() => {
  vi.useRealTimers()
})

describe('[COMP:ext/relay] Browser extension relay', () => {
  it('fences new commands with the latest Stop epoch without changing frames already sent', async () => {
    const relay = relayWithVerifier();
    const socket = pair(relay);
    const old = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'navigate' });
    const oldFrame = socket.sent.at(-1)!;
    expect(oldFrame.controlEpoch).toBeUndefined();
    relay.handleMessage(socket, JSON.stringify({ type: 'event', kind: 'stopped', controlEpoch: 2 }));
    await expect(old).resolves.toMatchObject({ ok: false, code: 'stopped' });
    expect(oldFrame.controlEpoch).toBeUndefined();
    const next = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'openTab' });
    const frame = socket.sent.at(-1)!;
    expect(frame).toMatchObject({ type: 'command', op: 'openTab', controlEpoch: 2 });
    relay.handleMessage(socket, JSON.stringify({ type: 'result', id: frame.id, ok: true }));
    await expect(next).resolves.toMatchObject({ ok: true });
    relay.handleMessage(socket, JSON.stringify({ type: 'event', kind: 'stopped', controlEpoch: 4 }));
    const later = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'navigate' });
    expect(socket.sent.at(-1)).toMatchObject({ controlEpoch: 4 });
    relay.handleDisconnect(socket);
    await expect(later).resolves.toMatchObject({ ok: false });
    const replacement = pair(relay);
    const fresh = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'navigate' });
    expect(replacement.sent.at(-1)?.controlEpoch).toBeUndefined();
    relay.handleDisconnect(replacement);
    await fresh;
  });
  it('verifies a P1.3 pairing token on hello and answers ready', () => {
    const relay = relayWithVerifier()
    const socket = pair(relay)
    expect(socket.sent).toEqual([{ type: 'ready' }])
    expect(relay.isConnected('user-1')).toBe(true)
  })

  it('rejects a bad pairing token with error + close 4401', () => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: 'garbage' }))
    expect(socket.sent[0]).toMatchObject({ type: 'error' })
    expect(socket.closed?.code).toBe(4401)
    expect(relay.isConnected('user-1')).toBe(false)
  })

  it('rejects a token signed with the wrong secret', () => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    const token = signBrowserExtPairToken(
      { userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE },
      'other-secret',
    )
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: token }))
    expect(socket.closed?.code).toBe(4401)
  })

  it('rejects a second hello on one socket so it cannot impersonate two profiles', () => {
    const relay = relayWithVerifier()
    const socket = pair(relay, 'user-1', CURRENT_EXTENSION_BUILD, 'profile-personal')
    const secondToken = signBrowserExtPairToken(
      { userId: 'user-1', workspaceId: 'ws-1', browserProfileId: 'profile-company' },
      SECRET,
    )

    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: secondToken }))

    expect(socket.closed?.code).toBe(4400)
    expect(relay.isConnected('user-1', 'profile-personal')).toBe(false)
    expect(relay.isConnected('user-1', 'profile-company')).toBe(false)
  })

  it('routes a command to the paired extension and resolves on its result (P1.4)', async () => {
    const relay = relayWithVerifier()
    const socket = pair(relay)

    const resultPromise = relay.dispatchCommand({
      userId: 'user-1',
      browserProfileId: PROFILE,
      op: 'snapshot',
    })
    const command = socket.sent.find((m) => m.type === 'command') as { id: string; op: string }
    expect(command.op).toBe('snapshot')

    relay.handleMessage(
      socket,
      JSON.stringify({ type: 'result', id: command.id, ok: true, data: { url: 'https://x.test/', title: '', nodes: [] } }),
    )
    await expect(resultPromise).resolves.toEqual({
      ok: true,
      data: { url: 'https://x.test/', title: '', nodes: [] },
    })
  })

  it('returns the clear no-extension error immediately when the user has no connection — never a hang', async () => {
    const relay = relayWithVerifier()
    const res = await relay.dispatchCommand({
      userId: 'nobody',
      browserProfileId: PROFILE,
      op: 'navigate',
      args: { url: 'https://x.test/' },
    })
    expect(res).toMatchObject({ ok: false, code: 'no_extension' })
  })

  it('queues Stop while disconnected and delivers it on reconnect', async () => {
    vi.useFakeTimers()
    const relay = relayWithVerifier()
    await expect(relay.dispatchCommand({
      userId: 'user-1',
      browserProfileId: PROFILE,
      op: 'stop',
    })).resolves.toEqual({
      ok: true,
      data: { stopped: true },
    })
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE })).toEqual({
      connected: false,
      terminalEvent: 'stopped',
      // Nothing connected: there is no build to report and nothing to update.
      build: null,
      staleBuild: false,
    })

    const first = pair(relay)
    expect(first.sent).toEqual([
      { type: 'ready' },
      expect.objectContaining({ type: 'command', op: 'stop', args: {} }),
    ])
    relay.handleDisconnect(first)

    const replacement = pair(relay)
    const stop = replacement.sent.find((message) => message.type === 'command') as { id: string; op: string }
    expect(stop.op).toBe('stop')
    relay.handleMessage(replacement, JSON.stringify({ type: 'result', id: stop.id, ok: true, data: { stopped: true } }))
    await vi.runAllTimersAsync()
    expect(replacement.sent.filter((message) => message.type === 'command')).toHaveLength(1)
  })

  it('times out an unanswered command with code timeout', async () => {
    vi.useFakeTimers()
    const relay = relayWithVerifier(1_000)
    pair(relay)
    const resultPromise = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'click', args: { ref: '@e1' } })
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(resultPromise).resolves.toMatchObject({ ok: false, code: 'timeout' })
  })

  it('forwards the server-resolved profile control mode with every command', async () => {
    const relay = relayWithVerifier()
    const socket = pair(relay)
    const resultPromise = relay.dispatchCommand({
      userId: 'user-1',
      browserProfileId: PROFILE,
      controlMode: 'full_browser',
      op: 'listTabs',
    })
    const command = socket.sent.find((message) => message.type === 'command') as {
      id: string
      controlMode?: string
    }
    expect(command.controlMode).toBe('full_browser')
    relay.handleMessage(
      socket,
      JSON.stringify({ type: 'result', id: command.id, ok: true, data: { tabs: [], activeTabId: null } }),
    )
    await expect(resultPromise).resolves.toMatchObject({ ok: true })
  })

  it('rejects in-flight commands when the extension emits event{stopped} (close-to-stop)', async () => {
    const relay = relayWithVerifier()
    const socket = pair(relay)
    const resultPromise = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'type', args: { ref: '@e1', text: 'hi' } })
    relay.handleMessage(socket, JSON.stringify({ type: 'event', kind: 'stopped' }))
    await expect(resultPromise).resolves.toMatchObject({ ok: false, code: 'stopped' })
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE })).toEqual({
      connected: true,
      terminalEvent: 'stopped',
      build: CURRENT_EXTENSION_BUILD,
      staleBuild: false,
    })
  })

  it('remembers tab_closed across reconnect until a successful new command', async () => {
    const relay = relayWithVerifier()
    const socket = pair(relay)
    relay.handleMessage(socket, JSON.stringify({ type: 'event', kind: 'tab_closed' }))
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE })).toEqual({
      connected: true,
      terminalEvent: 'tab_closed',
      build: CURRENT_EXTENSION_BUILD,
      staleBuild: false,
    })

    const replacement = pair(relay)
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE })).toEqual({
      connected: true,
      terminalEvent: 'tab_closed',
      build: CURRENT_EXTENSION_BUILD,
      staleBuild: false,
    })
    const resultPromise = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    const command = replacement.sent.find((message) => message.type === 'command') as { id: string }
    relay.handleMessage(replacement, JSON.stringify({ type: 'result', id: command.id, ok: true, data: {} }))
    await expect(resultPromise).resolves.toMatchObject({ ok: true })
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE })).toEqual({
      connected: true,
      terminalEvent: null,
      build: CURRENT_EXTENSION_BUILD,
      staleBuild: false,
    })
  })

  it('rejects in-flight commands when the extension emits event{detached}', async () => {
    // Chrome's debugging banner has its own Cancel, which ends the CDP session
    // without closing the tab. The waiting command must fail as `detached`
    // with its own message — reporting "the tab was closed" sends the model
    // hunting for a problem that is not there.
    const relay = relayWithVerifier()
    const socket = pair(relay)
    const resultPromise = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    relay.handleMessage(socket, JSON.stringify({ type: 'event', kind: 'detached' }))
    const res = await resultPromise
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('detached')
    expect(res.error).not.toMatch(/closed/i)
    expect(res.error).toMatch(/debugging session/i)
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE })).toEqual({
      connected: true,
      terminalEvent: null,
      build: CURRENT_EXTENSION_BUILD,
      staleBuild: false,
    })
  })

  it('rejects in-flight commands with no_extension when the socket disconnects', async () => {
    const relay = relayWithVerifier()
    const socket = pair(relay)
    const resultPromise = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    relay.handleDisconnect(socket)
    await expect(resultPromise).resolves.toMatchObject({ ok: false, code: 'no_extension' })
    expect(relay.isConnected('user-1')).toBe(false)
  })

  it('replaces an existing connection on re-pairing (latest wins) without dropping the new one', () => {
    const relay = relayWithVerifier()
    const first = pair(relay)
    const second = pair(relay)
    expect(first.closed?.code).toBe(4000)
    // The old socket's close event must not unregister the fresh connection.
    relay.handleDisconnect(first)
    expect(relay.isConnected('user-1')).toBe(true)
    expect(second.sent).toEqual([{ type: 'ready' }])
  })

  it('keeps separate profile connections live and routes their commands independently', async () => {
    const relay = relayWithVerifier()
    const personal = pair(relay, 'user-1', CURRENT_EXTENSION_BUILD, 'profile-personal')
    const company = pair(relay, 'user-1', CURRENT_EXTENSION_BUILD, 'profile-company')

    expect(personal.closed).toBeNull()
    expect(company.closed).toBeNull()
    expect(relay.connectionCount()).toBe(2)
    expect(relay.isConnected('user-1', 'profile-personal')).toBe(true)
    expect(relay.isConnected('user-1', 'profile-company')).toBe(true)

    const personalResult = relay.dispatchCommand({
      userId: 'user-1',
      browserProfileId: 'profile-personal',
      op: 'snapshot',
    })
    const companyResult = relay.dispatchCommand({
      userId: 'user-1',
      browserProfileId: 'profile-company',
      op: 'currentUrl',
    })
    const personalCommand = personal.sent.find((message) => message.type === 'command') as { id: string }
    const companyCommand = company.sent.find((message) => message.type === 'command') as { id: string }
    relay.handleMessage(personal, JSON.stringify({ type: 'result', id: personalCommand.id, ok: true, data: { profile: 'personal' } }))
    relay.handleMessage(company, JSON.stringify({ type: 'result', id: companyCommand.id, ok: true, data: { profile: 'company' } }))

    await expect(personalResult).resolves.toMatchObject({ ok: true, data: { profile: 'personal' } })
    await expect(companyResult).resolves.toMatchObject({ ok: true, data: { profile: 'company' } })
  })

  it('answers ping with pong and refuses non-hello frames from unpaired sockets', () => {
    const relay = relayWithVerifier()
    const socket = pair(relay)
    relay.handleMessage(socket, JSON.stringify({ type: 'ping' }))
    expect(socket.sent).toContainEqual({ type: 'pong' })

    const stranger = fakeSocket()
    relay.handleMessage(stranger, JSON.stringify({ type: 'ping' }))
    expect(stranger.closed?.code).toBe(4401)
  })

  it('closes connections that go silent past the liveness window', () => {
    vi.useFakeTimers()
    const relay = relayWithVerifier()
    const socket = pair(relay)
    vi.setSystemTime(Date.now() + LIVENESS_WINDOW_MS + 1_000)
    const closed = relay.sweepDead()
    expect(closed).toBe(1)
    expect(socket.closed?.code).toBe(4002)
    expect(relay.isConnected('user-1')).toBe(false)
  })

  it('drops malformed frames with error + close 4400', () => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    relay.handleMessage(socket, 'not json')
    expect(socket.closed?.code).toBe(4400)

    const socket2 = fakeSocket()
    relay.handleMessage(socket2, JSON.stringify({ type: 'launch_missiles' }))
    expect(socket2.closed?.code).toBe(4400)
  })
})

describe('[COMP:ext/relay] Session-token exchange', () => {
  function relayWithMinter(): BrowserRelay {
    return new BrowserRelay({
    authorize: () => true,
      verifyPairingToken: (token) => verifyBrowserExtHelloToken(token, SECRET),
      mintSessionToken: (identity) => signBrowserExtSessionToken(identity, SECRET),
    })
  }

  it('returns a session token in ready after a first-time pair-token hello', () => {
    const relay = relayWithMinter()
    const socket = fakeSocket()
    const token = signBrowserExtPairToken(
      { userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE },
      SECRET,
    )
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: token }))
    const ready = socket.sent[0] as { type: string; sessionToken?: string }
    expect(ready.type).toBe('ready')
    expect(typeof ready.sessionToken).toBe('string')
    const session = verifyBrowserExtSessionToken(ready.sessionToken as string, SECRET)
    expect(session).toMatchObject({
      kind: 'browser-ext-session',
      userId: 'user-1',
      workspaceId: 'ws-1',
      browserProfileId: PROFILE,
    })
  })

  it('accepts a session-token hello on reconnect without minting another token', () => {
    const relay = relayWithMinter()
    const socket = fakeSocket()
    const session = signBrowserExtSessionToken(
      { userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE },
      SECRET,
    )
    relay.handleMessage(
      socket,
      JSON.stringify({ type: 'hello', pairingToken: session, build: CURRENT_EXTENSION_BUILD }),
    )
    expect(socket.sent[0]).toEqual({ type: 'ready' })
    expect(relay.isConnected('user-1')).toBe(true)
  })

  it('judges the reported build once, at hello, and says so in ready', () => {
    const relay = relayWithVerifier()
    const stale = pair(relay, 'user-stale', 'deadbeefcafe')
    expect(stale.sent[0]).toEqual({ type: 'ready', staleBuild: true })
    expect(relay.connectionStatus('user-stale', { browserProfileId: PROFILE })).toMatchObject({
      build: 'deadbeefcafe',
      staleBuild: true,
    })
  })

  it('treats an extension that reports no build as stale', () => {
    // No special case, deliberately: an extension with nothing to report was
    // built before the stamp existed, so it is strictly older than the commit
    // that introduced it. That is exactly the population the 2026-08-03
    // incident came from, and exempting it would exempt the only users who
    // need telling.
    const relay = relayWithVerifier()
    const legacy = pair(relay, 'user-legacy', null)
    expect(legacy.sent[0]).toEqual({ type: 'ready', staleBuild: true })
    expect(relay.connectionStatus('user-legacy', { browserProfileId: PROFILE })).toMatchObject({
      build: null,
      staleBuild: true,
    })
  })

  it('marks a failing command as coming from a stale extension', async () => {
    const relay = relayWithVerifier()
    const socket = pair(relay, 'user-1', null)
    const resultPromise = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    const command = socket.sent.find((m) => m.type === 'command') as { id: string }
    relay.handleMessage(
      socket,
      JSON.stringify({ type: 'result', id: command.id, ok: false, error: 'nope', code: 'backend_error' }),
    )
    // Context on the failure, never a replacement for it: the api side appends
    // a remedy to the message so the assistant has something to tell the user
    // besides what broke.
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: 'nope',
      code: 'backend_error',
      staleBuild: true,
    })
  })

  it('does not mark a SUCCESSFUL command, even from a stale extension', async () => {
    const relay = relayWithVerifier()
    const socket = pair(relay, 'user-1', null)
    const resultPromise = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    const command = socket.sent.find((m) => m.type === 'command') as { id: string }
    relay.handleMessage(socket, JSON.stringify({ type: 'result', id: command.id, ok: true, data: {} }))
    // A stale build that worked is not a problem to narrate mid-task. The
    // popup and the connect panel carry that message; a tool result should
    // only ever explain a failure.
    await expect(resultPromise).resolves.toEqual({ ok: true, data: {} })
  })

  it('keeps the token kinds distinct: a pair token is not a session token and vice versa', () => {
    const pairTok = signBrowserExtPairToken(
      { userId: 'u', workspaceId: 'w', browserProfileId: PROFILE },
      SECRET,
    )
    const sessTok = signBrowserExtSessionToken(
      { userId: 'u', workspaceId: 'w', browserProfileId: PROFILE },
      SECRET,
    )
    expect(verifyBrowserExtSessionToken(pairTok, SECRET)).toBeNull()
    expect(verifyBrowserExtPairToken(sessTok, SECRET)).toBeNull()
    expect(verifyBrowserExtHelloToken(pairTok, SECRET)?.kind).toBe('browser-ext-pair')
    expect(verifyBrowserExtHelloToken(sessTok, SECRET)?.kind).toBe('browser-ext-session')
  })
})

describe('[COMP:ext/relay] Relay internal auth', () => {
  it('matches only the exact shared secret, constant-time, fail-closed', () => {
    expect(relaySecretMatches('s3cret', 's3cret')).toBe(true)
    expect(relaySecretMatches('nope', 's3cret')).toBe(false)
    expect(relaySecretMatches(undefined, 's3cret')).toBe(false)
    expect(relaySecretMatches('anything', '')).toBe(false)
  })
})

describe('protected fill human approval budget', () => {
  it('keeps the command live beyond generic timeout but bounds it at 120 seconds', async () => {
    vi.useFakeTimers()
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', capabilities: { protectedFillV1: true }, pairingToken: signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE }, SECRET) }), 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    let done = false
    const pending = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'browserFillReference' })
    void pending.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(90_000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await pending).ok).toBe(false)
  })
})


describe('protected fill transport eligibility', () => {
  it.each([undefined, 'moz-extension://firefox-id', 'https://page.example'])('fails closed on unsupported upgrade origin %s', async origin => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', capabilities: { protectedFillV1: true }, pairingToken: signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE }, SECRET) }), origin)
    const result = await relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'browserFillReference' })
    expect(result).toEqual({ ok: false, error: 'Protected fill unavailable', code: 'protected_fill_denied' })
    expect(socket.sent.filter(msg => msg.type === 'command')).toHaveLength(0)
  })
})


describe('protected fill explicit protocol capability', () => {
  it.each([undefined, { protectedFillV1: false }, { protectedFillV1: true }])('persists hello capability %j, independent of current build fingerprint', async capabilities => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    const token = signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE }, SECRET)
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: token, build: CURRENT_EXTENSION_BUILD, capabilities }), 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE }).capabilities?.protectedFillV1 === true).toBe(capabilities?.protectedFillV1 === true)
    const pending = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'browserFillReference' })
    if (capabilities?.protectedFillV1 === true) {
      const command = socket.sent.find(m => m.type === 'command')!
      relay.handleMessage(socket, JSON.stringify({ type: 'result', id: command.id, ok: true }))
      expect((await pending).ok).toBe(true)
    } else {
      expect((await pending).ok).toBe(false)
      expect(socket.sent.some(m => m.type === 'command')).toBe(false)
    }
  })
  it('rejects malformed truthy capability instead of coercing it', () => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: 'anything', capabilities: { protectedFillV1: 'true' } }))
    expect(socket.closed?.code).toBe(4400)
  })
})


describe('capability is bound to the current paired connection', () => {
  it('does not inherit support when an older install replaces a capable connection', async () => {
    const relay = relayWithVerifier()
    const token = signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE }, SECRET)
    const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    relay.handleMessage(fakeSocket(), JSON.stringify({ type: 'hello', pairingToken: token, capabilities: { protectedFillV1: true } }), origin)
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE }).capabilities?.protectedFillV1).toBe(true)
    relay.handleMessage(fakeSocket(), JSON.stringify({ type: 'hello', pairingToken: token }), origin)
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE }).capabilities).toBeUndefined()
    expect((await relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'browserFillReference' })).ok).toBe(false)
  })
})

describe('Electron compatibility metadata', () => {
  it.each([undefined, 'old-electron-build'])('skips extension staleness for Electron build %s, never grants protected fill', async build => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    const token = signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE }, SECRET)
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: token,
      clientKind: 'electron', build, capabilities: { protectedFillV1: true },
    }), 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(socket.sent[0]).toEqual({ type: 'ready' })
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE })).toMatchObject({ staleBuild: false })
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE }).capabilities).toBeUndefined()
    expect(await relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'browserFillReference' }))
      .toEqual({ ok: false, error: 'Protected fill unavailable', code: 'protected_fill_denied' })
    expect(socket.sent.some(msg => msg.type === 'command')).toBe(false)
  })

  it('still requires a valid pairing token', () => {
    const relay = relayWithVerifier()
    const socket = fakeSocket()
    relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken: 'invalid', clientKind: 'electron' }))
    expect(socket.sent[0]).toMatchObject({ type: 'error' })
    expect(relay.isConnected('user-1')).toBe(false)
  })
})


describe('[COMP:ext/relay] current department authority', () => {
  function fixture() {
    const authorize = vi.fn<(token: string) => boolean | Promise<boolean>>(() => true)
    const relay = new BrowserRelay({ authorize,
      verifyPairingToken: token => verifyBrowserExtHelloToken(token, SECRET),
      mintSessionToken: identity => signBrowserExtSessionToken(identity, SECRET) })
    return { relay, authorize }
  }

  it('denies previously signed tokens after revocation and on lookup failure', async () => {
    const { relay, authorize } = fixture()
    authorize.mockReturnValue(false)
    const denied = pair(relay)
    expect(denied.closed?.code).toBe(4401)
    expect(relay.connectionCount()).toBe(0)
    authorize.mockRejectedValueOnce(new Error('private lookup'))
    const socket = fakeSocket()
    await relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken:
      signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE }, SECRET) }))
    expect(socket.closed?.code).toBe(4401)
    expect(JSON.stringify(socket.sent)).not.toContain('private lookup')
  })

  it('checks dispatch and result release, rejecting pending data after revocation', async () => {
    const { relay, authorize } = fixture()
    const socket = pair(relay)
    const pending = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    const command = socket.sent.at(-1)!
    authorize.mockReturnValue(false)
    await relay.handleMessage(socket, JSON.stringify({ type: 'result', id: command.id, ok: true, data: 'protected content' }))
    expect(await pending).toMatchObject({ ok: false, code: 'no_extension' })
    expect(socket.closed?.code).toBe(4401)
    authorize.mockReturnValue(true)
    const next = pair(relay)
    authorize.mockReturnValue(false)
    expect(await relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'navigate' }))
      .toMatchObject({ ok: false })
    expect(next.sent.filter(frame => frame.type === 'command')).toHaveLength(0)
  })

  it('renews with the exchanged session token and closes idle revoked connections', async () => {
    const { relay, authorize } = fixture()
    const socket = pair(relay)
    const session = socket.sent.find(frame => frame.type === 'ready')!.sessionToken
    authorize.mockReturnValue(false)
    await relay.renewAuthority()
    expect(authorize).toHaveBeenLastCalledWith(session)
    expect(relay.connectionCount()).toBe(0)
    expect(socket.closed?.code).toBe(4401)
  })

  it('does not resurrect a socket disconnected during admission', async () => {
    const { relay, authorize } = fixture()
    let admit!: (value: boolean) => void
    authorize.mockReturnValue(new Promise<boolean>(resolve => { admit = resolve }))
    const socket = fakeSocket()
    const hello = relay.handleMessage(socket, JSON.stringify({ type: 'hello', pairingToken:
      signBrowserExtPairToken({ userId: 'user-1', workspaceId: 'ws-1', browserProfileId: PROFILE }, SECRET) }))
    relay.handleDisconnect(socket)
    admit(true)
    await hello
    expect(relay.connectionCount()).toBe(0)
    expect(socket.sent).toEqual([])
  })

  it('does not dispatch to a replaced socket after an asynchronous approval', async () => {
    const { relay, authorize } = fixture()
    const old = pair(relay)
    let admit!: (value: boolean) => void
    authorize.mockReturnValueOnce(new Promise<boolean>(resolve => { admit = resolve }))
    const command = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    const replacement = pair(relay)
    admit(true)
    expect(await command).toMatchObject({ ok: false })
    expect(old.sent.filter(frame => frame.type === 'command')).toHaveLength(0)
    expect(replacement.closed).toBeNull()
  })

  it('preserves the safety Stop path when authority is revoked', async () => {
    const { relay, authorize } = fixture()
    const socket = pair(relay)
    authorize.mockReturnValue(false)
    const stopped = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'stop' })
    const command = socket.sent.at(-1)!
    expect(command.op).toBe('stop')
    await relay.handleMessage(socket, JSON.stringify({ type: 'result', id: command.id, ok: true, data: { privatePage: 'SECRET_SENTINEL' } }))
    expect(await stopped).toEqual({ ok: true, data: { stopped: true } })
    expect(socket.closed?.code).toBe(4401)
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE }).terminalEvent).toBe('stopped')
  })

  it('withholds failed Stop payloads and does not report them as completed', async () => {
    const { relay, authorize } = fixture()
    const socket = pair(relay)
    const stopped = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'stop' })
    const command = socket.sent.at(-1)!
    authorize.mockReturnValue(false)
    await relay.handleMessage(socket, JSON.stringify({ type: 'result', id: command.id, ok: false, error: 'SECRET_SENTINEL', code: 'SECRET_SENTINEL' }))
    expect(await stopped).toEqual({ ok: false, error: 'Browser Stop could not be confirmed.', code: 'backend_error' })
    expect(socket.closed?.code).toBe(4401)
    expect(relay.connectionStatus('user-1', { browserProfileId: PROFILE }).terminalEvent).toBeNull()
  })

  it('does not treat an unrelated result ID as a safety Stop acknowledgement', async () => {
    const { relay, authorize } = fixture()
    const socket = pair(relay)
    const stopped = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'stop' })
    authorize.mockReturnValue(false)
    await relay.handleMessage(socket, JSON.stringify({ type: 'result', id: 'unrelated-id', ok: true, data: { stopped: true } }))
    expect(await stopped).toMatchObject({ ok: false })
    expect(socket.closed?.code).toBe(4401)
  })
})


describe('[COMP:ext/relay] retained task binding', () => {
  const command = (taskId: string, op = 'navigate') => ({ userId: 'user-1', browserProfileId: PROFILE, taskId, op })
  async function answer(relay: BrowserRelay, socket: FakeSocket, pending: Promise<unknown>) {
    const message = socket.sent.at(-1)!
    expect(message.type).toBe('command')
    expect(message).not.toHaveProperty('taskId')
    await relay.handleMessage(socket, JSON.stringify({ type: 'result', id: message.id, ok: true, data: { value: 'fixture' } }))
    return pending
  }
  it('retires a replaced binding and denies its reads, navigation, Stop and unbound commands', async () => {
    const relay = relayWithVerifier(), socket = pair(relay)
    await answer(relay, socket, relay.dispatchCommand(command('task-a')))
    await answer(relay, socket, relay.dispatchCommand(command('task-b')))
    const before = socket.sent.length
    for (const op of ['snapshot', 'navigate', 'stop']) expect(await relay.dispatchCommand(command('task-a', op))).toMatchObject({ ok: false, code: 'no_active_browser' })
    expect(await relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })).toMatchObject({ ok: false, code: 'no_active_browser' })
    expect(socket.sent).toHaveLength(before)
    await answer(relay, socket, relay.dispatchCommand(command('task-b', 'snapshot')))
    await answer(relay, socket, relay.dispatchCommand(command('task-b', 'stop')))
    expect(await relay.dispatchCommand(command('task-b'))).toMatchObject({ ok: false, code: 'no_active_browser' })
  })
  it('serializes replacements and checks the queued old Stop only after the newer task binds', async () => {
    const relay = relayWithVerifier(), socket = pair(relay)
    const first = relay.dispatchCommand(command('task-a'))
    const replacement = relay.dispatchCommand(command('task-b'))
    const staleStop = relay.dispatchCommand(command('task-a', 'stop'))
    expect(socket.sent.filter(m => m.type === 'command')).toHaveLength(1)
    await answer(relay, socket, first)
    await vi.waitFor(() => expect(socket.sent.filter(m => m.type === 'command')).toHaveLength(2))
    await answer(relay, socket, replacement)
    expect(await staleStop).toMatchObject({ ok: false, code: 'no_active_browser' })
    expect(socket.sent.filter(m => m.type === 'command')).toHaveLength(2)
  })
  it('does not forward a queued command to a replacement socket', async () => {
    const relay = relayWithVerifier(), old = pair(relay)
    const first = relay.dispatchCommand(command('task-a'))
    const queued = relay.dispatchCommand(command('task-b'))
    const replacement = pair(relay)
    expect(await first).toMatchObject({ ok: false })
    expect(await queued).toMatchObject({ ok: false, code: 'no_extension' })
    expect(replacement.sent.filter(m => m.type === 'command')).toHaveLength(0)
    expect(old.closed?.code).toBe(4000)
  })
  it('does not defer a task-scoped Stop onto a future pairing', async () => {
    const relay = relayWithVerifier()
    expect(await relay.dispatchCommand(command('task-a', 'stop'))).toMatchObject({ ok: false, code: 'no_extension' })
    const socket = pair(relay)
    expect(socket.sent.filter(m => m.type === 'command')).toHaveLength(0)
    expect(await relay.dispatchCommand(command('task-a', 'snapshot'))).toMatchObject({ ok: false, code: 'no_active_browser' })
  })
  it('closes an uncertain timed-out binding and refuses its queued replacement', async () => {
    vi.useFakeTimers()
    const relay = relayWithVerifier(25), socket = pair(relay)
    const first = relay.dispatchCommand(command('task-a'))
    const queued = relay.dispatchCommand(command('task-b'))
    await vi.advanceTimersByTimeAsync(30)
    expect(await first).toMatchObject({ ok: false, code: 'timeout' })
    expect(await queued).toMatchObject({ ok: false, code: 'no_extension' })
    expect(socket.closed?.code).toBe(4401)
    expect(socket.sent.filter(m => m.type === 'command')).toHaveLength(1)
    vi.useRealTimers()
  })
  it('refuses first binding until prior unbound work has completed', async () => {
    const relay = relayWithVerifier(), socket = pair(relay)
    const legacy = relay.dispatchCommand({ userId: 'user-1', browserProfileId: PROFILE, op: 'snapshot' })
    expect(await relay.dispatchCommand(command('task-a'))).toMatchObject({ ok: false, code: 'no_active_browser' })
    await answer(relay, socket, legacy)
    await answer(relay, socket, relay.dispatchCommand(command('task-a')))
  })
  it('retires the connection at the binding-history limit instead of forgetting old task IDs', async () => {
    const relay = relayWithVerifier(), socket = pair(relay)
    for (let i = 0; i < 1024; i++) await answer(relay, socket, relay.dispatchCommand(command(`task-${i}`)))
    expect(await relay.dispatchCommand(command('task-over-limit'))).toMatchObject({ ok: false, code: 'no_extension' })
    expect(socket.closed?.code).toBe(4401)
    expect(await relay.dispatchCommand(command('task-0'))).toMatchObject({ ok: false, code: 'no_extension' })
  })

})
