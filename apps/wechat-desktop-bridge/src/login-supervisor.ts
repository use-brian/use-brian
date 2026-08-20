/**
 * Login supervisor: mirrors the container's auth state into the custom-channel
 * state (`PUT /state`), and drives the QR login WebSocket when signed out so
 * the QR reaches Studio (a box with no GUI is paired from the Studio panel).
 * Spec: docs/architecture/channels/wechat-desktop.md → "Login supervisor".
 */
import type { AgentWechatClient, AgentWechatLoginEvent, LoginSubscription } from './agent-wechat-client.js'
import type { BrianBridgeClient } from './brian-bridge-client.js'
import { consoleLogger, errorMessage, type Logger } from './log.js'
import type { BridgeState } from './protocol-types.js'

const AUTH_POLL_MS = 10_000
const MAX_LOGIN_TIMEOUTS = 6

/** Known container phrasings → our own sentence. The DEFAULT branch is ours too. */
const KNOWN_LOGIN_ERRORS: Array<{ match: RegExp; message: string }> = [
  { match: /not running|app_not_running|wechat.*(exited|crashed)/i, message: 'The WeChat client inside the container is not running. It restarts itself; if this persists, restart the compose stack.' },
  { match: /timed? ?out|timeout/i, message: 'Login timed out before the QR was scanned. A fresh QR will be issued.' },
  { match: /already logged in/i, message: 'This account is already signed in on the desktop client.' },
  { match: /logged in elsewhere|another device|kicked/i, message: 'WeChat signed this desktop session out because the account was used on another desktop. Scan again from Studio.' },
  { match: /network|connection refused|unreachable|ECONNREFUSED/i, message: 'The container cannot reach WeChat right now. It will retry.' },
  { match: /qr.*(expired|invalid)/i, message: 'The QR code expired before it was scanned. A fresh QR will be issued.' },
  { match: /cancel/i, message: 'The login was cancelled on the phone. Scan again from Studio.' },
]

export const DEFAULT_LOGIN_ERROR = 'WeChat login failed inside the container. Restart the compose stack, then scan again from Studio.'

/** Map a vendor error sentence to our wording; the vendor text survives only as `cause`. */
export function translateLoginError(vendor: string | undefined): { message: string; cause: string } {
  const cause = (vendor ?? '').trim()
  for (const k of KNOWN_LOGIN_ERRORS) {
    if (cause && k.match.test(cause)) return { message: k.message, cause }
  }
  return { message: DEFAULT_LOGIN_ERROR, cause: cause || '(no message from container)' }
}

export type LoginSupervisorDeps = {
  agent: AgentWechatClient
  bridge: BrianBridgeClient
  bridgeVersion: string
  authPollMs?: number
  log?: Logger
  /** Called when a state publish throws FatalConfigError (token revoked / channel deleted). */
  onFatal?: (err: unknown) => void
}

export type LoginSupervisor = {
  start(): Promise<void>
  stop(): void
  /** One auth poll. Exposed for tests. */
  tick(): Promise<void>
  isLoggedIn(): boolean
  /** Disconnect requested from Studio: log out, publish `disconnected`, never re-open the login WS until restart. */
  disconnect(): Promise<void>
  /** The last state we published (for tests / health). */
  lastPublished(): BridgeState | null
}

export function createLoginSupervisor(deps: LoginSupervisorDeps): LoginSupervisor {
  const log = deps.log ?? consoleLogger
  const authPollMs = deps.authPollMs ?? AUTH_POLL_MS
  let timer: ReturnType<typeof setInterval> | null = null
  let loggedIn = false
  let disconnectedByUser = false
  let givenUp = false
  let loginWs: LoginSubscription | null = null
  let timeouts = 0
  let last: BridgeState | null = null
  let ticking = false

  async function publish(state: BridgeState): Promise<void> {
    // `documents: true` is a promise the outbox worker keeps: it performs a
    // real file send for `payload.documents` (outbox-worker.ts), so the
    // platform's `sendFile` may admit this channel.
    const next: BridgeState = {
      ...state,
      bridgeVersion: deps.bridgeVersion,
      capabilities: { documents: true, ...state.capabilities },
    }
    if (last && JSON.stringify(last) === JSON.stringify(next)) return
    try {
      await deps.bridge.putState(next)
      last = next
    } catch (err) {
      if ((err as { name?: string })?.name === 'FatalConfigError') {
        deps.onFatal?.(err)
        return
      }
      log.warn(`state publish failed (${state.status}): ${errorMessage(err)}`)
    }
  }

  function closeLoginWs(): void {
    if (loginWs) {
      const ws = loginWs
      loginWs = null
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  function openLoginWs(): void {
    if (loginWs || disconnectedByUser || givenUp) return
    log.info('opening login WebSocket')
    let handle: LoginSubscription | null = null
    handle = deps.agent.subscribeLogin({
      onEvent: (event) => void handleEvent(event, () => handle),
      onError: (err) => {
        log.warn(`login WebSocket error: ${err.message}`)
      },
      onClose: () => {
        if (loginWs === handle) loginWs = null
      },
    })
    loginWs = handle
    void publish({ status: 'connecting', message: 'Waiting for the WeChat client to issue a login QR.' })
  }

  async function handleEvent(event: AgentWechatLoginEvent, self: () => LoginSubscription | null): Promise<void> {
    switch (event.type) {
      case 'qr': {
        const action: BridgeState['action'] = event.qrDataUrl
          ? { kind: 'qr', imageDataUrl: event.qrDataUrl }
          : { kind: 'qr', text: event.qrData }
        await publish({ status: 'needs_action', message: 'Scan the QR with WeChat on your phone.', action })
        return
      }
      case 'phone_confirm':
        await publish({
          status: 'needs_action',
          message: event.message || 'Confirm the login on your phone.',
          action: { kind: 'confirm_on_device', message: event.message || 'Confirm the login on your phone.' },
        })
        return
      case 'status':
        await publish({ ...(last ?? { status: 'connecting' }), message: event.message })
        return
      case 'login_success':
        loggedIn = true
        timeouts = 0
        closeLoginWs()
        await publish({ status: 'connected', message: 'Signed in.', accountLabel: event.userId || undefined })
        return
      case 'login_timeout': {
        timeouts += 1
        const ws = self()
        if (ws && ws === loginWs) loginWs = null
        ws?.close()
        if (timeouts >= MAX_LOGIN_TIMEOUTS) {
          givenUp = true
          await publish({ status: 'error', message: 'Login timed out; reconnect from Studio.' })
          return
        }
        openLoginWs()
        return
      }
      case 'error': {
        const { message, cause } = translateLoginError(event.message)
        log.warn(`login error from container: ${cause}`)
        const ws = self()
        if (ws && ws === loginWs) loginWs = null
        ws?.close()
        await publish({ status: 'error', message })
        return
      }
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      let auth
      try {
        auth = await deps.agent.authStatus()
      } catch (err) {
        loggedIn = false
        log.warn(`auth status failed: ${errorMessage(err)}`)
        await publish({ status: 'error', message: 'The agent-wechat container is not answering. Check that it is running.' })
        return
      }
      if (auth.status === 'logged_in') {
        loggedIn = true
        timeouts = 0
        closeLoginWs()
        await publish({ status: 'connected', message: 'Signed in.', accountLabel: auth.loggedInUser || undefined })
        return
      }
      loggedIn = false
      if (disconnectedByUser) {
        await publish({ status: 'disconnected', message: 'Disconnected from Studio. Restart the bridge service to pair again.' })
        return
      }
      if (auth.status === 'app_not_running') {
        await publish({ status: 'connecting', message: 'The WeChat client is starting inside the container.' })
        return
      }
      if (!loginWs && !givenUp) openLoginWs()
    } finally {
      ticking = false
    }
  }

  return {
    async start() {
      await tick()
      timer = setInterval(() => void tick(), authPollMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      closeLoginWs()
    },
    tick,
    isLoggedIn: () => loggedIn,
    async disconnect() {
      disconnectedByUser = true
      closeLoginWs()
      loggedIn = false
      try {
        await deps.agent.logout()
      } catch (err) {
        log.warn(`logout failed: ${errorMessage(err)}`)
      }
      await publish({ status: 'disconnected', message: 'Disconnected from Studio. Restart the bridge service to pair again.' })
    },
    lastPublished: () => last,
  }
}
