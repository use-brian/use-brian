/**
 * IMAP session reuse (D12 #1 — the latency requirement).
 *
 * IMAP login is the expensive step (~2s TLS + AUTH against AliMail); an
 * agentic search loop refines queries several times per turn, so each
 * refinement must reuse the authenticated connection (~100ms) instead of
 * reconnecting. Tools are rebuilt per turn, so a cache keyed by connector
 * instance gives every call in a turn the same session; an idle timer (60s
 * default) closes it shortly after the turn ends. A hard lifetime cap bounds
 * how long a credential stays resident regardless of activity.
 *
 * The client surface is a narrow structural interface over imapflow so unit
 * tests inject fakes (`createClient` option) — no network in tests.
 *
 * [COMP:api/mailbox-imap-client]
 */

import { ImapFlow } from 'imapflow'
import type { MailboxAccountSettings } from './types.js'

/** The subset of imapflow this module consumes (structural, fake-able). */
export type ImapClientLike = {
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  list(): Promise<Array<{ path: string; specialUse?: string }>>
  getMailboxLock(path: string): Promise<{ release(): void }>
  search(query: unknown, opts: { uid: true }): Promise<number[] | false>
  fetch(
    range: string,
    query: Record<string, unknown>,
    opts: { uid: true },
  ): AsyncIterable<ImapFetchedMessage>
  fetchOne(
    id: string,
    query: Record<string, unknown>,
    opts?: { uid: true },
  ): Promise<ImapFetchedMessage | false>
  status(
    path: string,
    query: { messages: true; uidNext: true; uidValidity: true },
  ): Promise<{ path: string; messages?: number; uidNext?: number; uidValidity?: bigint }>
  append(path: string, content: Buffer, flags?: string[]): Promise<unknown>
  usable: boolean
}

export type ImapFetchedMessage = {
  uid: number
  envelope?: {
    date?: Date
    subject?: string
    messageId?: string
    inReplyTo?: string
    from?: Array<{ name?: string; address?: string }>
    to?: Array<{ name?: string; address?: string }>
    cc?: Array<{ name?: string; address?: string }>
  }
  headers?: Buffer
  internalDate?: Date
  source?: Buffer
}

export const MAILBOX_SESSION_IDLE_MS = 60_000
export const MAILBOX_SESSION_MAX_LIFETIME_MS = 10 * 60_000
/**
 * Max inactivity on the IMAP socket before imapflow aborts the read as an
 * error. Without it a server that stops responding mid-FETCH hangs the sync
 * tick indefinitely; with it the backfill's chunk bisection (sync-worker.ts)
 * gets a throw it can isolate and step over. Inactivity-based, so a slow but
 * still-streaming large fetch is not killed.
 */
export const MAILBOX_SOCKET_TIMEOUT_MS = 90_000
export const MAILBOX_GREETING_TIMEOUT_MS = 20_000

export function createImapClient(settings: MailboxAccountSettings): ImapClientLike {
  return new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: true,
    auth: { user: settings.email, pass: settings.appPassword },
    logger: false,
    greetingTimeout: MAILBOX_GREETING_TIMEOUT_MS,
    socketTimeout: MAILBOX_SOCKET_TIMEOUT_MS,
  }) as unknown as ImapClientLike
}

type SessionEntry = {
  clientPromise: Promise<ImapClientLike>
  createdAt: number
  inFlight: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

export type MailboxSessionCache = {
  /** Run `fn` against the cached (or freshly connected) client for `key`. */
  withClient<T>(
    key: string,
    settings: MailboxAccountSettings,
    fn: (client: ImapClientLike) => Promise<T>,
  ): Promise<T>
  /** Close every cached session (shutdown / tests). */
  closeAll(): Promise<void>
  size(): number
}

export function createMailboxSessionCache(opts?: {
  createClient?: (settings: MailboxAccountSettings) => ImapClientLike
  idleMs?: number
  maxLifetimeMs?: number
}): MailboxSessionCache {
  const createClient = opts?.createClient ?? createImapClient
  const idleMs = opts?.idleMs ?? MAILBOX_SESSION_IDLE_MS
  const maxLifetimeMs = opts?.maxLifetimeMs ?? MAILBOX_SESSION_MAX_LIFETIME_MS
  const sessions = new Map<string, SessionEntry>()

  async function closeEntry(key: string, entry: SessionEntry): Promise<void> {
    sessions.delete(key)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    try {
      const client = await entry.clientPromise
      try {
        await client.logout()
      } catch {
        client.close()
      }
    } catch {
      // Connect never succeeded — nothing to close.
    }
  }

  function armIdleTimer(key: string, entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      if (entry.inFlight > 0) {
        armIdleTimer(key, entry)
        return
      }
      void closeEntry(key, entry)
    }, idleMs)
    entry.idleTimer.unref?.()
  }

  return {
    async withClient(key, settings, fn) {
      let entry = sessions.get(key)
      if (entry && Date.now() - entry.createdAt > maxLifetimeMs && entry.inFlight === 0) {
        await closeEntry(key, entry)
        entry = undefined
      }
      if (!entry) {
        const fresh: SessionEntry = {
          clientPromise: (async () => {
            const client = createClient(settings)
            await client.connect()
            return client
          })(),
          createdAt: Date.now(),
          inFlight: 0,
          idleTimer: null,
        }
        sessions.set(key, fresh)
        entry = fresh
      }
      entry.inFlight++
      try {
        const client = await entry.clientPromise
        const result = await fn(client)
        if (!client.usable) void closeEntry(key, entry)
        return result
      } catch (err) {
        // A dead connection (or a failed connect) must not be served to the
        // next call — drop the entry so the next call reconnects.
        const current = sessions.get(key)
        if (current === entry) {
          try {
            const client = await entry.clientPromise
            if (!client.usable) void closeEntry(key, entry)
          } catch {
            sessions.delete(key)
            if (entry.idleTimer) clearTimeout(entry.idleTimer)
          }
        }
        throw err
      } finally {
        entry.inFlight--
        if (sessions.get(key) === entry) armIdleTimer(key, entry)
      }
    },

    async closeAll() {
      const entries = [...sessions.entries()]
      sessions.clear()
      await Promise.all(
        entries.map(async ([, entry]) => {
          if (entry.idleTimer) clearTimeout(entry.idleTimer)
          try {
            const client = await entry.clientPromise
            try {
              await client.logout()
            } catch {
              client.close()
            }
          } catch {
            // ignore
          }
        }),
      )
    },

    size() {
      return sessions.size
    },
  }
}

/** Process-wide default cache used by the tool injection path. */
export const defaultMailboxSessionCache = createMailboxSessionCache()
