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
 * Component tag: [COMP:app/wechat-connector].
 */

import {
  createIlinkClient,
  createWechatAdapter,
  createDedupBuffer,
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

export type PollerManagerOptions = {
  apiUrl: string
  connectorSecret: string
}

export type PollerManager = {
  connect(
    channelId: string,
    input: { botToken: string; baseUrl: string; getUpdatesBuf?: string },
  ): ManagedPoller
  disconnect(channelId: string): void
  getStatus(channelId: string): ManagedPoller | null
  disconnectAll(): void
  restoreAll(): Promise<void>
}

type LoopState = {
  snapshot: ManagedPoller
  abort: AbortController
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
  const loops = new Map<string, LoopState>()

  async function forwardToApi(channelId: string, message: unknown): Promise<void> {
    try {
      const res = await fetch(`${apiUrl}/internal/wechat/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Secret': options.connectorSecret,
        },
        body: JSON.stringify({ channelId, message }),
      })
      if (!res.ok) {
        console.error(`[wechat-poller] inbound forward failed for ${channelId}: ${res.status}`)
      }
    } catch (err) {
      console.error(`[wechat-poller] inbound forward error for ${channelId}:`, err)
    }
  }

  async function persistCursor(channelId: string, getUpdatesBuf: string): Promise<void> {
    try {
      const res = await fetch(`${apiUrl}/internal/wechat/cursor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Secret': options.connectorSecret,
        },
        body: JSON.stringify({ channelId, getUpdatesBuf }),
      })
      if (!res.ok) {
        console.warn(`[wechat-poller] cursor persist failed for ${channelId}: ${res.status}`)
      }
    } catch (err) {
      console.warn(`[wechat-poller] cursor persist error for ${channelId}:`, err)
    }
  }

  async function runLoop(
    channelId: string,
    input: { botToken: string; baseUrl: string; getUpdatesBuf?: string },
    state: LoopState,
  ): Promise<void> {
    const client = createIlinkClient({ baseUrl: input.baseUrl, token: input.botToken })
    // Parse-only adapter — normalizes raw WeixinMessages; sends never happen here.
    const adapter = createWechatAdapter({ baseUrl: input.baseUrl, botToken: input.botToken })
    const dedup = createDedupBuffer()
    const signal = state.abort.signal

    await client.notifyStart().catch(() => {})

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
            `[wechat-poller] ${channelId}: getupdates failed ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          )
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0
        state.snapshot.lastEventAt = Date.now()

        if (resp.get_updates_buf != null && resp.get_updates_buf !== '' && resp.get_updates_buf !== getUpdatesBuf) {
          getUpdatesBuf = resp.get_updates_buf
          void persistCursor(channelId, getUpdatesBuf)
        }

        for (const raw of resp.msgs ?? []) {
          const dedupId = adapter.deduplicateId(raw)
          if (dedupId && dedup.isDuplicate(dedupId)) continue
          const incoming = adapter.parseIncoming(raw)
          if (!incoming) continue
          await forwardToApi(channelId, incoming)
        }
      } catch (err) {
        if (signal.aborted) break
        consecutiveFailures += 1
        console.error(
          `[wechat-poller] ${channelId}: getupdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
          err,
        )
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }

    state.snapshot.status = 'stopped'
    await client.notifyStop().catch(() => {})
  }

  return {
    connect(channelId, input) {
      // Replace any existing loop for this channel — iLink allows exactly one
      // poller per account (exclusive lock), so the old loop must die first.
      const existing = loops.get(channelId)
      if (existing) existing.abort.abort()

      const state: LoopState = {
        snapshot: { channelId, status: 'polling' },
        abort: new AbortController(),
      }
      loops.set(channelId, state)
      void runLoop(channelId, input, state).catch((err) => {
        console.error(`[wechat-poller] ${channelId}: loop crashed:`, err)
        state.snapshot.status = 'stopped'
      })
      return state.snapshot
    },

    disconnect(channelId) {
      const state = loops.get(channelId)
      if (!state) return
      state.abort.abort()
      loops.delete(channelId)
    },

    getStatus(channelId) {
      return loops.get(channelId)?.snapshot ?? null
    },

    disconnectAll() {
      for (const state of loops.values()) state.abort.abort()
      loops.clear()
    },

    async restoreAll() {
      let rows: Array<{ channelId: string; botToken: string; baseUrl: string; getUpdatesBuf?: string }>
      try {
        const res = await fetch(`${apiUrl}/internal/wechat/channels`, {
          headers: { 'X-Connector-Secret': options.connectorSecret },
        })
        if (!res.ok) {
          console.warn(`[wechat-poller] restoreAll skipped: API returned ${res.status}`)
          return
        }
        rows = (await res.json()) as typeof rows
      } catch (err) {
        console.warn('[wechat-poller] restoreAll skipped: API unreachable:', err)
        return
      }
      for (const row of rows) {
        this.connect(row.channelId, {
          botToken: row.botToken,
          baseUrl: row.baseUrl,
          getUpdatesBuf: row.getUpdatesBuf,
        })
      }
      console.log(`[wechat-poller] restored ${rows.length} channel(s)`)
    },
  }
}
