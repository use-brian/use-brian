/**
 * Outbox worker: long-polls `/outbox` (also the liveness heartbeat), performs
 * each item sequentially against the container, and acks `{ok, error}`.
 * Spec: docs/architecture/channels/wechat-desktop.md → "Outbox worker".
 */
import type { AgentWechatClient } from './agent-wechat-client.js'
import type { BrianBridgeClient } from './brian-bridge-client.js'
import { consoleLogger, errorMessage, sleep as defaultSleep, type Logger } from './log.js'
import { chunkText, markdownToWechat } from './markdown-to-wechat.js'
import type { OutboxAckResult, OutboxItem } from './protocol-types.js'

const OUTBOX_WAIT_MS = 25_000
const OUTBOX_LIMIT = 20
const ERROR_BACKOFF_MS = 3000
/** An empty poll that returns faster than this is an API ignoring `wait`; pause so we never hot-loop. */
const FAST_EMPTY_POLL_MS = 1000

export type OutboxWorkerDeps = {
  agent: AgentWechatClient
  bridge: BrianBridgeClient
  /** Studio asked to disconnect: log out + publish + stop re-pairing. */
  onDisconnect: () => Promise<void>
  log?: Logger
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  waitMs?: number
  limit?: number
  onFatal?: (err: unknown) => void
}

export type OutboxWorker = {
  start(): void
  stop(): void
  /** Perform one item and return its ack result. Exposed for tests. */
  handleItem(item: OutboxItem): Promise<OutboxAckResult>
}

export function createOutboxWorker(deps: OutboxWorkerDeps): OutboxWorker {
  const log = deps.log ?? consoleLogger
  const sleep = deps.sleep ?? defaultSleep
  const abort = new AbortController()
  let loopPromise: Promise<void> | null = null

  async function sendText(peerId: string, text: string): Promise<OutboxAckResult | null> {
    for (const chunk of chunkText(text)) {
      const res = await deps.agent.sendMessage({ chatId: peerId, text: chunk })
      if (!res.success) return { id: '', ok: false, error: res.error || 'The WeChat client did not send the message.' }
    }
    return null
  }

  async function handleItem(item: OutboxItem): Promise<OutboxAckResult> {
    try {
      switch (item.type) {
        case 'message': {
          const { text, format, documents } = item.payload
          const flat = format === 'markdown' ? markdownToWechat(text) : text
          if (flat.trim()) {
            const failed = await sendText(item.peerId, flat)
            if (failed) return { ...failed, id: item.id }
          }
          for (const doc of documents ?? []) {
            const res = await deps.agent.sendMessage({
              chatId: item.peerId,
              file: { data: doc.dataBase64, filename: doc.filename },
            })
            if (!res.success) {
              return { id: item.id, ok: false, error: res.error || `The WeChat client did not send ${doc.filename}.` }
            }
            if (doc.caption?.trim()) {
              const failed = await sendText(item.peerId, doc.caption)
              if (failed) return { ...failed, id: item.id }
            }
          }
          return { id: item.id, ok: true }
        }
        case 'typing':
          // The desktop client cannot emit a typing indicator.
          return { id: item.id, ok: true }
        case 'status': {
          const failed = await sendText(item.peerId, item.payload.text)
          return failed ? { ...failed, id: item.id } : { id: item.id, ok: true }
        }
        case 'input':
          // This platform never asks for typed input; the phone confirms.
          return { id: item.id, ok: true }
        case 'disconnect':
          await deps.onDisconnect()
          return { id: item.id, ok: true }
        default:
          return { id: (item as { id: string }).id, ok: false, error: 'Unknown outbox item type.' }
      }
    } catch (err) {
      return { id: item.id, ok: false, error: errorMessage(err) }
    }
  }

  async function loop(): Promise<void> {
    while (!abort.signal.aborted) {
      let items: OutboxItem[]
      const startedAt = Date.now()
      try {
        items = await deps.bridge.pollOutbox({
          waitMs: deps.waitMs ?? OUTBOX_WAIT_MS,
          limit: deps.limit ?? OUTBOX_LIMIT,
          signal: abort.signal,
        })
      } catch (err) {
        if (abort.signal.aborted) return
        if ((err as { name?: string })?.name === 'FatalConfigError') {
          deps.onFatal?.(err)
          return
        }
        log.warn(`outbox poll failed: ${errorMessage(err)}`)
        await sleep(ERROR_BACKOFF_MS, abort.signal)
        continue
      }
      if (items.length === 0) {
        if (Date.now() - startedAt < FAST_EMPTY_POLL_MS) await sleep(FAST_EMPTY_POLL_MS, abort.signal)
        continue
      }
      const results: OutboxAckResult[] = []
      for (const item of items) {
        if (abort.signal.aborted) break
        results.push(await handleItem(item))
      }
      try {
        await deps.bridge.ack(results)
      } catch (err) {
        if ((err as { name?: string })?.name === 'FatalConfigError') {
          deps.onFatal?.(err)
          return
        }
        // Unacked items reappear after the lease; the next round will settle them.
        log.warn(`outbox ack failed: ${errorMessage(err)}`)
      }
    }
  }

  return {
    start() {
      if (!loopPromise) loopPromise = loop()
    },
    stop() {
      abort.abort()
    },
    handleItem,
  }
}
