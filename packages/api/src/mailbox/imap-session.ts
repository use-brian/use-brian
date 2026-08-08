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
  list(): Promise<Array<{ path: string; specialUse?: string; flags?: Set<string> }>>
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
  /**
   * Stream ONE BODYSTRUCTURE part, transfer-encoding already decoded
   * (Phase 3 / D14). This is the only byte path for attachments — the
   * `source` fetch `getMessage` uses is byte-capped and would truncate.
   */
  download(
    range: string,
    part: string,
    opts: { uid: true },
  ): Promise<{
    meta?: { contentType?: string; filename?: string; expectedSize?: number }
    content: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void }
  }>
  /**
   * Keep the socket from going quiet while we hold the session but are not
   * talking IMAP (the backfill's per-message DB insert phase — sync-worker.ts).
   * `socketTimeout` is INACTIVITY-based, so a long insert phase reads to the
   * socket exactly like a dead server.
   */
  noop(): Promise<unknown>
  /**
   * imapflow surfaces post-connect failures as an `'error'` EVENT, not a
   * rejection — see `attachSessionErrorSink`. Registering a listener is the
   * only thing that stops Node rethrowing it as an uncaughtException.
   */
  on(event: 'error', listener: (err: unknown) => void): unknown
  usable: boolean
}

/** Folders excluded from sync — junk/trash/drafts and virtual all-mail. */
const SKIP_SPECIAL_USE = new Set(['\\Junk', '\\Trash', '\\Drafts', '\\All'])

/**
 * Attributes meaning "this LIST entry is a container, not a mailbox". `SELECT`
 * / `EXAMINE` on one is refused by the server.
 *
 * This is the 2026-08-08 root cause. Gmail's LIST includes a bare `[Gmail]`
 * node, flagged `\Noselect`, that exists only to parent `[Gmail]/Sent Mail`
 * and friends. It has no special-use attribute, so the special-use filter let
 * it through. `STATUS` on it happens to answer `0` — which is why the cheap
 * preflight probe was perfectly happy and even counted it — but
 * `getMailboxLock()` issues a `SELECT`, the server answers `NO`, and imapflow
 * throws the bare string `Command failed`.
 *
 * It only ever bit once a backfill was armed: the delta walk locks a folder
 * only when `uidNext - 1 > lastUid`, which for an always-empty container is
 * never, while the backfill branch locks unconditionally before its `SEARCH`.
 * That is why three mailboxes each froze within seconds of arming a backfill,
 * and why every folder LISTED AFTER `[Gmail]` — 83,736 messages on one account
 * — was never synced at all.
 */
const NON_SELECTABLE_FLAGS = ['\\Noselect', '\\NonExistent']

/**
 * The folders a sync pass may open, from a raw `list()`. Shared by the worker
 * and the preflight probe so the two can never disagree about what is
 * syncable — they had two hand-maintained copies of the special-use set, and a
 * count the probe offered for a folder the worker then choked on is exactly
 * the kind of drift that produced a 155,363-message estimate the backfill
 * could never reach.
 */
export function syncableFolders<T extends { specialUse?: string; flags?: Set<string> }>(
  listed: T[],
): T[] {
  return listed.filter((f) => {
    if (f.specialUse && SKIP_SPECIAL_USE.has(f.specialUse)) return false
    if (f.flags && NON_SELECTABLE_FLAGS.some((flag) => f.flags?.has(flag))) return false
    return true
  })
}

/**
 * One BODYSTRUCTURE node as imapflow parses it. The server's own part tree —
 * the sole authority for part ids and attachment listings (D14).
 */
export type ImapBodyStructureNode = {
  /** Dotted IMAP part number ("2", "1.2"). Absent on the root of a single-part message. */
  part?: string
  /** Lowercased MIME type, e.g. "application/pdf". */
  type: string
  parameters?: Record<string, string>
  disposition?: string
  dispositionParameters?: Record<string, string>
  /** Encoded octets as the server reports them. */
  size?: number
  encoding?: string
  childNodes?: ImapBodyStructureNode[]
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
  bodyStructure?: ImapBodyStructureNode
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
/**
 * How long the socket may sit quiet while we hold the session but are NOT
 * talking IMAP, before we spend a NOOP to keep it warm. Must stay well under
 * `MAILBOX_SOCKET_TIMEOUT_MS` — the NOOP itself needs room to complete.
 */
export const MAILBOX_KEEP_WARM_MS = 30_000

/** Guards the non-IMAP phase of a sync against the inactivity timeout. */
export type SocketKeepWarm = {
  /**
   * Call once per unit of non-IMAP work. Issues a NOOP only when the socket
   * has actually been quiet longer than `everyMs`, so a fast loop costs
   * nothing. Rethrows if the session is gone: the caller's walk must abort
   * rather than keep inserting against a dead connection.
   */
  pingIfIdle(): Promise<void>
}

/**
 * `socketTimeout` is INACTIVITY-based, not a command deadline — it fires when
 * no bytes cross the socket for `MAILBOX_SOCKET_TIMEOUT_MS`, and it cannot
 * tell a dead server from a busy client. The sync worker fetches a chunk of
 * messages, releases the mailbox lock, then spends the next stretch on
 * per-message MIME parsing, archive inserts and (delta path) brain routing —
 * all of it with the IMAP session still held and the socket silent. When those
 * inserts are slow (a starved DB pool, statement timeouts) the quiet stretch
 * passes 90 s and imapflow kills the connection out from under a walk that was
 * making perfectly good progress.
 *
 * Raising or dropping the timeout is the wrong lever: it exists so a server
 * that stops responding mid-FETCH cannot hang the tick forever, and the
 * backfill's poison-UID bisection needs that throw. The fix is to stop holding
 * a silent socket while we work — one cheap NOOP per idle window.
 */
export function createSocketKeepWarm(
  client: ImapClientLike,
  opts?: { everyMs?: number; now?: () => number },
): SocketKeepWarm {
  const everyMs = opts?.everyMs ?? MAILBOX_KEEP_WARM_MS
  const now = opts?.now ?? (() => Date.now())
  // Seeded at construction: the caller builds this right after the fetch that
  // was the socket's last real activity.
  let lastActivity = now()
  return {
    async pingIfIdle() {
      if (now() - lastActivity < everyMs) return
      await client.noop()
      lastActivity = now()
    },
  }
}

/**
 * Register the `'error'` sink every long-lived IMAP session must carry.
 *
 * imapflow is an EventEmitter, and once `connect()` has resolved it reports
 * every later failure — socket timeout, mid-command disconnect, server reset —
 * by calling `emitError`, which ends in `this.emit('error', err)`. Node's
 * EventEmitter treats `'error'` as a special case: with **zero** listeners it
 * RETHROWS the error instead of dropping it. That throw happens on the timer
 * stack that fired it (`Socket._onTimeout`), so no `try/catch` around any
 * `await` of ours is on the stack to catch it — the process dies with
 * `Unhandled 'error' event`.
 *
 * That is not theoretical: from 2026-07-28 the single-instance
 * `brian-api-workers` container crash-looped every ~100 s for two days on
 * `Error: Socket timeout` out of a mailbox backfill, taking all 19 background
 * workers with it. Every scheduled workflow run longer than the crash interval
 * orphaned mid-flight (216 rows stuck `pending`/`running`), because a SIGKILL
 * leaves no status behind.
 *
 * Attaching the listener is not swallowing the error — `emitError` calls
 * `closeAfter()` BEFORE emitting, so the connection is already torn down and
 * `usable` is already false. The listener only stops the process death, which
 * lets the failure path that already exists run: the in-flight command
 * rejects, `withClient` drops the dead session, and `syncInstance` records
 * `lastError` on the instance and logs the failure. One tick degrades instead
 * of the whole fleet dying.
 */
export function attachSessionErrorSink(
  client: ImapClientLike,
  label: string,
  log: (msg: string) => void = (msg) => console.warn(msg),
): void {
  client.on('error', (err) => {
    const text = err instanceof Error ? err.message : String(err)
    const code = (err as { code?: string } | null)?.code
    log(`[mailbox] IMAP session error for ${label}: ${text}${code ? ` (${code})` : ''}`)
  })
}

export function createImapClient(settings: MailboxAccountSettings): ImapClientLike {
  const client = new ImapFlow({
    host: settings.imapHost,
    port: settings.imapPort,
    secure: true,
    auth: { user: settings.email, pass: settings.appPassword },
    logger: false,
    greetingTimeout: MAILBOX_GREETING_TIMEOUT_MS,
    socketTimeout: MAILBOX_SOCKET_TIMEOUT_MS,
  }) as unknown as ImapClientLike
  attachSessionErrorSink(client, settings.email)
  return client
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
