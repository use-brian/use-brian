/**
 * Per-channel iLink long-poll loops (the WeChat analogue of the Discord
 * gateway-manager). One loop per connected bot: getupdates → normalize via the
 * shared adapter → POST `/internal/wechat/inbound`. Inbound-only — outbound
 * sends go API → iLink REST directly and never pass through here (W3).
 *
 * Loop semantics mirror the reference plugin's monitor:
 * - The opaque `get_updates_buf` cursor is echoed each poll and persisted to
 *   the API (`POST /internal/wechat/cursor`) whenever it changes, so a bridge
 *   restart resumes without message loss (Cloud Run disk is ephemeral).
 * - The server may suggest the next long-poll timeout (`longpolling_timeout_ms`).
 * - errcode -14 = stale bot token → pause the loop ~1h instead of hot-looping
 *   (hammering a dead token risks the account).
 * - 3 consecutive failures → 30s backoff, else 2s retry.
 * - notifystart/notifystop bracket the loop lifecycle (best-effort).
 *
 * Many bots, one service (docs/architecture/channels/wechat.md →
 * "Multi-connection operation"): every loop owns its credentials, cursor,
 * dedup buffer, retry counters and stale-token pause, so one bot's failure
 * never touches another. iLink allows ONE poller per bot, so replacement is
 * serialized per channel and awaits the previous loop's exit (including
 * `notifystop`) before the replacement's `notifystart`, and a second channel
 * presenting a bot id another live loop holds is refused. Every inbound and
 * cursor write carries the loop's transport `generation`; the API ignores a
 * stale one, and a loop told its cursor generation is stale stops itself.
 *
 * Component tag: [COMP:app/wechat-connector].
 */

import {
  createIlinkClient,
  createWechatAdapter,
  createDedupBuffer,
  describeWechatPayload,
  ILINK_STALE_TOKEN_ERRCODE,
} from '@use-brian/channels'

const LONG_POLL_TIMEOUT_MS = 35_000
const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000
const STALE_TOKEN_PAUSE_MS = 60 * 60_000

type ManagedPoller = {
  channelId: string
  status: 'polling' | 'paused' | 'stopped'
  lastEventAt?: number
}

export type PollerConnectInput = {
  botToken: string
  baseUrl: string
  /** iLink bot id; lets the manager refuse a second live loop for the same bot. */
  botId?: string
  /** Transport generation; tags every inbound and cursor write. */
  generation?: number
  getUpdatesBuf?: string
}

/** A second channel tried to poll a bot another live loop already holds. */
export class DuplicateBotError extends Error {
  readonly code = 'duplicate_bot'
  constructor(readonly channelId: string, readonly heldBy: string) {
    super(`bot is already polled by channel ${heldBy}`)
    this.name = 'DuplicateBotError'
  }
}

type IlinkLike = Pick<ReturnType<typeof createIlinkClient>, 'notifyStart' | 'notifyStop' | 'getUpdates'>
type AdapterLike = Pick<ReturnType<typeof createWechatAdapter>, 'parseIncoming' | 'deduplicateId'>

/** Injectable transport seams (tests run many fake bots without Tencent). */
type PollerManagerDeps = {
  createClient?: (config: { baseUrl: string; token: string }) => IlinkLike
  createAdapter?: (config: { baseUrl: string; botToken: string }) => AdapterLike
  fetch?: typeof fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export type PollerManagerOptions = {
  apiUrl: string
  connectorSecret: string
  deps?: PollerManagerDeps
}

export type PollerManager = {
  connect(channelId: string, input: PollerConnectInput): Promise<ManagedPoller>
  disconnect(channelId: string): Promise<void>
  getStatus(channelId: string): ManagedPoller | null
  disconnectAll(): Promise<void>
  restoreAll(): Promise<void>
}

type LoopState = {
  snapshot: ManagedPoller
  abort: AbortController
  done: Promise<void>
  botId?: string
  generation?: number
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function createPollerManager(options: PollerManagerOptions): PollerManager {
  const apiUrl = options.apiUrl.replace(/\/$/, '')
  const deps = options.deps ?? {}
  const createClient = deps.createClient ?? ((c) => createIlinkClient(c))
  const createAdapter = deps.createAdapter ?? ((c) => createWechatAdapter(c))
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const loops = new Map<string, LoopState>()
  /** Per-channel lifecycle chain: connect/disconnect never interleave. */
  const chains = new Map<string, Promise<unknown>>()

  function serialized<T>(channelId: string, op: () => Promise<T>): Promise<T> {
    const prev = chains.get(channelId) ?? Promise.resolve()
    const next = prev.then(op, op)
    chains.set(channelId, next.catch(() => undefined))
    return next
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return doFetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connector-Secret': options.connectorSecret },
      body: JSON.stringify(body),
    })
  }

  async function forwardToApi(channelId: string, generation: number | undefined, message: unknown): Promise<void> {
    try {
      const res = await post('/internal/wechat/inbound', { channelId, ...(generation ? { generation } : {}), message })
      if (!res.ok) console.error(`[wechat-poller] inbound forward failed for ${channelId}: ${res.status}`)
    } catch (err) {
      console.error(`[wechat-poller] inbound forward error for ${channelId}:`, (err as Error).message)
    }
  }

  /** Returns false when the API reports this loop's generation is stale. */
  async function persistCursor(channelId: string, generation: number | undefined, getUpdatesBuf: string): Promise<boolean> {
    try {
      const res = await post('/internal/wechat/cursor', { channelId, getUpdatesBuf, ...(generation ? { generation } : {}) })
      if (res.status === 409) return false
      if (!res.ok) console.warn(`[wechat-poller] cursor persist failed for ${channelId}: ${res.status}`)
    } catch (err) {
      console.warn(`[wechat-poller] cursor persist error for ${channelId}:`, (err as Error).message)
    }
    return true
  }

  async function runLoop(channelId: string, input: PollerConnectInput, state: LoopState): Promise<void> {
    const client = createClient({ baseUrl: input.baseUrl, token: input.botToken })
    // Parse-only adapter — normalizes raw WeixinMessages; sends never happen here.
    const adapter = createAdapter({ baseUrl: input.baseUrl, botToken: input.botToken })
    const dedup = createDedupBuffer()
    const signal = state.abort.signal

    try {
      const notified = await client.notifyStart()
      if (notified.ret !== undefined && notified.ret !== 0) {
        console.warn(`[wechat-poller] ${channelId}: notifystart returned ret=${notified.ret}`)
      }
    } catch (err) {
      // Tencent treats this as online reconciliation rather than the transport
      // itself, so keep polling but retain the reason behind an offline badge.
      console.warn(`[wechat-poller] ${channelId}: notifystart failed:`, (err as Error).message)
    }

    let getUpdatesBuf = input.getUpdatesBuf ?? ''
    let nextTimeoutMs = LONG_POLL_TIMEOUT_MS
    let consecutiveFailures = 0

    while (!signal.aborted) {
      try {
        const resp = await client.getUpdates({ getUpdatesBuf, timeoutMs: nextTimeoutMs, abortSignal: signal })
        if (signal.aborted) break

        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms
        }

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0)
        if (isApiError) {
          const isStaleToken =
            resp.errcode === ILINK_STALE_TOKEN_ERRCODE || resp.ret === ILINK_STALE_TOKEN_ERRCODE
          if (isStaleToken) {
            console.error(
              `[wechat-poller] ${channelId}: bot token stale (errcode ${ILINK_STALE_TOKEN_ERRCODE}), pausing ${STALE_TOKEN_PAUSE_MS / 60_000} min`,
            )
            state.snapshot.status = 'paused'
            consecutiveFailures = 0
            await sleep(STALE_TOKEN_PAUSE_MS, signal)
            state.snapshot.status = signal.aborted ? 'stopped' : 'polling'
            continue
          }
          consecutiveFailures += 1
          console.error(
            `[wechat-poller] ${channelId}: getupdates failed ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          )
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0
        state.snapshot.lastEventAt = Date.now()

        if (resp.get_updates_buf != null && resp.get_updates_buf !== '' && resp.get_updates_buf !== getUpdatesBuf) {
          getUpdatesBuf = resp.get_updates_buf
          void persistCursor(channelId, state.generation, getUpdatesBuf).then((current) => {
            if (current || signal.aborted) return
            // The API holds a newer transport for this channel: this loop was
            // replaced elsewhere and must not keep polling the bot.
            console.warn(`[wechat-poller] ${channelId}: transport generation is stale, stopping this loop`)
            state.abort.abort()
          })
        }

        for (const raw of resp.msgs ?? []) {
          if (signal.aborted) break
          const dedupId = adapter.deduplicateId(raw)
          if (dedupId && dedup.isDuplicate(dedupId)) continue
          const incoming = adapter.parseIncoming(raw)
          if (!incoming) {
            // `parseIncoming` discards at five gates and says nothing. Without
            // this line an attachment that never reaches the archive is
            // indistinguishable from one iLink never delivered — and silence
            // on a media path reads as "no message was sent", which is the
            // one conclusion that is never safe to draw. `describeWechatPayload`
            // reports structure only; it carries no message content.
            console.warn(
              `[wechat-poller] ${channelId}: inbound dropped by adapter (${dedupId ?? 'no dedup id'}): ${describeWechatPayload(raw)}`,
            )
            continue
          }
          if (incoming.mediaType) {
            console.log(`[wechat-poller] ${channelId}: inbound carries ${incoming.mediaType} — forwarding for archive staging`)
          }
          await forwardToApi(channelId, state.generation, incoming)
        }
      } catch (err) {
        if (signal.aborted) break
        consecutiveFailures += 1
        console.error(
          `[wechat-poller] ${channelId}: getupdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          (err as Error).message,
        )
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }

    state.snapshot.status = 'stopped'
    await client.notifyStop().catch((err: unknown) => {
      console.warn(`[wechat-poller] ${channelId}: notifystop failed:`, (err as Error).message)
    })
  }

  async function stop(channelId: string): Promise<void> {
    const state = loops.get(channelId)
    if (!state) return
    state.abort.abort()
    await state.done
    if (loops.get(channelId) === state) loops.delete(channelId)
  }

  const manager: PollerManager = {
    connect(channelId, input) {
      return serialized(channelId, async () => {
        if (input.botId) {
          for (const [other, state] of loops) {
            if (other !== channelId && state.botId === input.botId && !state.abort.signal.aborted) {
              throw new DuplicateBotError(channelId, other)
            }
          }
        }
        // Exactly one poller per bot: the previous loop fully exits (and
        // sends notifystop) before the replacement sends notifystart.
        await stop(channelId)
        const state: LoopState = {
          snapshot: { channelId, status: 'polling' },
          abort: new AbortController(),
          done: Promise.resolve(),
          botId: input.botId,
          generation: input.generation,
        }
        state.done = runLoop(channelId, input, state).catch((err: unknown) => {
          console.error(`[wechat-poller] ${channelId}: loop crashed:`, (err as Error).message)
          state.snapshot.status = 'stopped'
        })
        loops.set(channelId, state)
        return state.snapshot
      })
    },

    disconnect(channelId) {
      return serialized(channelId, () => stop(channelId))
    },

    getStatus(channelId) {
      return loops.get(channelId)?.snapshot ?? null
    },

    async disconnectAll() {
      await Promise.all([...loops.keys()].map((channelId) => manager.disconnect(channelId)))
    },

    async restoreAll() {
      let rows: Array<PollerConnectInput & { channelId: string }>
      try {
        const res = await doFetch(`${apiUrl}/internal/wechat/channels`, {
          headers: { 'X-Connector-Secret': options.connectorSecret },
        })
        if (!res.ok) {
          console.warn(`[wechat-poller] restoreAll skipped: API returned ${res.status}`)
          return
        }
        rows = (await res.json()) as typeof rows
      } catch (err) {
        console.warn('[wechat-poller] restoreAll skipped: API unreachable:', (err as Error).message)
        return
      }
      const results = await Promise.allSettled(rows.map((row) => manager.connect(row.channelId, {
        botToken: row.botToken,
        baseUrl: row.baseUrl,
        botId: row.botId,
        generation: row.generation,
        getUpdatesBuf: row.getUpdatesBuf,
      })))
      const refused = results.filter((r) => r.status === 'rejected').length
      console.log(`[wechat-poller] restored ${rows.length - refused} channel(s)${refused ? `, refused ${refused} conflicting` : ''}`)
    },
  }
  return manager
}
