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
