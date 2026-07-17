/**
 * Per-channel Baileys socket lifecycle manager.
 *
 * Manages WebSocket connections to WhatsApp's servers — one socket per
 * channel. Handles QR pairing, reconnection with backoff, deduplication
 * of self-echoes, and credential persistence via GCS.
 *
 * Ported from OpenClaw: session.ts (socket creation), active-listener.ts
 * (socket registry), inbound/monitor.ts (message listener + dedup + reconnect).
 *
 * See docs/architecture/channels/whatsapp.md.
 */

import type { Bucket } from '@google-cloud/storage'
import type pg from 'pg'
import type { AnyMessageContent, ConnectionState, WAMessage, WASocket } from '@whiskeysockets/baileys'
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import { join } from 'node:path'
import pino from 'pino'

/**
 * LOCAL DEV ONLY — when `WA_LOCAL_CREDS_DIR` is set, persist Baileys auth
 * state to the local filesystem (Baileys' `useMultiFileAuthState`) instead of
 * GCS. Lets a developer pair + test without GCP credentials or a GCS
 * emulator. Never set in production (Cloud Run has no durable local disk).
 */
const LOCAL_CREDS_DIR = process.env.WA_LOCAL_CREDS_DIR ?? null
import {
  useGCSAuthState,
  authStateExists,
  deleteAuthState,
  listStoredChannels,
  waitForCredsSaveQueue,
} from './gcs-auth-state.js'
import {
  usePostgresAuthState,
  deleteAuthStatePg,
  listStoredChannelsPg,
  waitForCredsSaveQueuePg,
} from './pg-auth-state.js'
import {
  extractText,
  extractMediaPlaceholder,
  extractMediaInfo,
  isDownloadableMedia,
  describeReplyContext,
  extractEditedMessage,
  type WhatsAppIncomingMessage,
} from './message-parser.js'
import { shouldStreamMedia } from './media-routing.js'

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401
const MAX_RECONNECT_ATTEMPTS = 12
/** Max media size to download and forward (10 MB). */
const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30000
/**
 * Recency window for `append`-typed messages. `messages.upsert` fires `notify`
 * for new messages from others (the listener's main path) and `append` for
 * messages synced from the owner's OTHER devices — i.e. the owner typing in a
 * group from their primary phone. We ingest those `fromMe` appends so a BYON
 * listener captures the owner's own contributions too, but only when fresh:
 * an initial reconnect can replay older self-messages as `append`, and this
 * window keeps that from flooding the brain. Bulk history arrives on a
 * separate `messaging-history.set` event we don't tap, so this is belt-and-suspenders.
 */
const APPEND_MAX_AGE_MS = 5 * 60 * 1000
const RECONNECT_FACTOR = 1.8

/**
 * Where a channel's Baileys credentials live. `gcs` = official responder
 * channels (the legacy default); `postgres` = BYON ingest channels (the
 * `wa_auth_state` table); `local` = dev-only filesystem (WA_LOCAL_CREDS_DIR).
 * The API requests `gcs` or `db` at connect time; restore derives it from
 * which store actually holds the creds.
 */
type CredBackend = 'gcs' | 'postgres' | 'local'

/** What the connect entrypoint accepts (normalized to CredBackend). */
type RequestedBackend = 'gcs' | 'db'

type ManagedSocket = {
  channelId: string
  sock: WASocket
  status: 'connecting' | 'connected' | 'disconnected' | 'qr_pending'
  backend: CredBackend
  qr?: string
  phoneNumber?: string
  connectedAt?: number
  /**
   * Set before we deliberately `sock.end()` a socket (connect-replace, or
   * disconnect). The `connection: 'close'` handler reads it to suppress the
   * automatic reconnect — otherwise replacing a socket (e.g. a second connect
   * for the same channel, like a QR retry) would fire a phantom reconnect that
   * races the new socket into a 440 session-conflict storm, and the fresh QR
   * never reaches the client.
   */
  intentionalClose?: boolean
}

type QrListener = (qr: string) => void
type ConnectedListener = (phoneNumber: string) => void
type ErrorListener = (error: string) => void

export type SocketManagerOptions = {
  bucket: Bucket
  /** BYON credential store. Null when DATABASE_URL is unset (BYON connect 503s). */
  pool: pg.Pool | null
  apiUrl: string
  connectorSecret: string
}

export type SocketManager = {
  connect(
    channelId: string,
    listeners?: {
      onQr?: QrListener
      onConnected?: ConnectedListener
      onError?: ErrorListener
    },
    backend?: RequestedBackend,
  ): Promise<ManagedSocket>
  disconnect(channelId: string, deleteCreds?: boolean): Promise<void>
  disconnectAll(): Promise<void>
  /**
   * Send a message. `channelId` may also be a stable alias — `auto` (the
   * single connected channel) or `pn:<digits>` (by paired phone number) — so
   * external senders never have to pin the channel UUID, which changes on
   * every re-pair. See `resolveManaged`.
   */
  send(
    channelId: string,
    jid: string,
    content: AnyMessageContent,
  ): Promise<{ messageId: string }>
  /**
   * Every registered socket with its live state — the discovery surface for
   * external senders (`GET /connections`) to find a channel id / verify an
   * alias would resolve.
   */
  listConnections(): {
    channelId: string
    status: ManagedSocket['status']
    phoneNumber?: string
    backend: CredBackend
    connectedAt?: number
  }[]
  /**
   * List every group the connected number participates in. Each entry carries
   * the group jid + subject and the participant JIDs (used by the bot's
   * `group_members` access mode to answer only people who share a group).
   */
  listGroups(
    channelId: string,
  ): Promise<{ jid: string; subject: string; participants: string[] }[]>
  /**
   * Leave a group. Used when the official bot is added to a group whose adder
   * has no sidanclaw account (unresolvable) — the bot leaves rather than ingest.
   */
  groupLeave(channelId: string, groupJid: string): Promise<void>
  getStatus(channelId: string): ManagedSocket | undefined
  restoreAll(): Promise<void>
}

export function createSocketManager(options: SocketManagerOptions): SocketManager {
  const { bucket, pool, apiUrl, connectorSecret } = options
  const sockets = new Map<string, ManagedSocket>()

  /**
   * Resolve a connect request's backend hint to a concrete store. `db` always
   * means Postgres (requires a pool). `gcs`/undefined means GCS in prod, but
   * the local-FS override when WA_LOCAL_CREDS_DIR is set.
   */
  function resolveBackend(requested?: RequestedBackend): CredBackend {
    if (requested === 'db') {
      if (!pool) throw new Error('BYON requires DATABASE_URL (no Postgres pool configured)')
      return 'postgres'
    }
    return LOCAL_CREDS_DIR ? 'local' : 'gcs'
  }

  /**
   * Resolve a channel id OR a stable alias to its managed socket:
   *   - exact channel id — the normal case;
   *   - `auto` — the single currently-connected channel. Lets a single-number
   *     deployment (e.g. an external MCP that sends through this connector)
   *     avoid pinning the channel UUID, which changes on every re-pair;
   *   - `pn:<digits>` — the connected channel whose paired phone number
   *     matches (digits compared, separators ignored). Stable across
   *     re-pairings of the same number.
   * Alias failures throw descriptive errors (none connected / ambiguous / no
   * matching number); an unknown plain id returns undefined so callers keep
   * their existing "no active connection" message.
   */
  function resolveManaged(idOrAlias: string): ManagedSocket | undefined {
    const direct = sockets.get(idOrAlias)
    if (direct) return direct
    const connected = [...sockets.values()].filter((s) => s.status === 'connected')
    if (idOrAlias === 'auto') {
      if (connected.length === 1) return connected[0]
      throw new Error(
        connected.length === 0
          ? `Alias 'auto': no connected WhatsApp channel`
          : `Alias 'auto' is ambiguous: ${connected.length} connected channels (${connected
              .map((s) => s.channelId)
              .join(', ')}) — use pn:<digits> or the channel id`,
      )
    }
    if (idOrAlias.startsWith('pn:')) {
      const digits = idOrAlias.slice(3).replace(/\D/g, '')
      const match = connected.find((s) => (s.phoneNumber ?? '').replace(/\D/g, '') === digits)
      if (match) return match
      throw new Error(`Alias 'pn:${digits}': no connected channel with that phone number`)
    }
    return undefined
  }

  /** Delete a channel's creds from whichever store it lives in. */
  async function deleteCredsFor(channelId: string, backend: CredBackend): Promise<void> {
    if (backend === 'postgres') {
      if (pool) await deleteAuthStatePg(pool, channelId)
    } else if (backend === 'gcs') {
      await deleteAuthState(bucket, channelId)
    }
    // 'local' creds are dev-only filesystem dirs; left in place on logout.
  }

  /** Drain the pending creds-save queue for a channel on its backend. */
  function drainSaveQueue(channelId: string, backend: CredBackend): Promise<void> {
    return backend === 'postgres'
      ? waitForCredsSaveQueuePg(channelId)
      : waitForCredsSaveQueue(`channels/${channelId}`)
  }

  // ── Outbound dedup store (self-echo suppression) ──
  //
  // Dual-mode invariant: one stream can carry both a *listener* (read-only
  // ingest of every human message) and a *bot* (AI sends through this socket).
  // Both bot sends AND human messages typed from the connected companion number
  // arrive on `messages.upsert` with `key.fromMe === true`. A blanket `fromMe`
  // drop would silently eat real human messages from the paired phone — those
  // are content the listener must still ingest. So we must NOT drop on `fromMe`
  // alone: instead we record the id of every AI-generated send at SEND time and
  // suppress an inbound echo ONLY when its id is one we sent. Human `fromMe`
  // messages (never recorded here) fall through and are forwarded normally.
  //
  // WhatsApp message ids are unique per send, so the store keys on
  // `(channelId, messageId)` — the chat jid is irrelevant for identity.
  //
  // TTL-bounded: an echo follows its send within seconds, so a 10-minute TTL is
  // generous. Eviction is by AGE (not a per-key insertion cap), so a busy group
  // can never push out a still-live entry — stale entries just age out. A hard
  // size cap bounds memory; when hit we drop the oldest first.
  const OUTBOUND_DEDUP_TTL_MS = 10 * 60 * 1000 // 10 minutes
  const OUTBOUND_DEDUP_MAX = 5000
  // key = `${channelId}:${messageId}` → epoch-ms the bot sent it
  const recentOutbound = new Map<string, number>()

  function outboundKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`
  }

  function pruneOutbound(now: number) {
    // Evict aged-out entries first (Map preserves insertion order, oldest first).
    for (const [key, sentAt] of recentOutbound) {
      if (now - sentAt < OUTBOUND_DEDUP_TTL_MS) break // the rest are newer
      recentOutbound.delete(key)
    }
    // Hard size cap: drop oldest until under the limit.
    while (recentOutbound.size > OUTBOUND_DEDUP_MAX) {
      const oldest = recentOutbound.keys().next().value
      if (oldest === undefined) break
      recentOutbound.delete(oldest)
    }
  }

  /** Record an AI-generated send so its inbound echo can be suppressed. */
  function rememberOutbound(channelId: string, messageId: string) {
    const now = Date.now()
    recentOutbound.set(outboundKey(channelId, messageId), now)
    pruneOutbound(now)
  }

  /** True only for ids we recorded at send time that have not aged out. */
  function isRecentOutbound(channelId: string, messageId: string): boolean {
    const key = outboundKey(channelId, messageId)
    const sentAt = recentOutbound.get(key)
    if (sentAt === undefined) return false
    if (Date.now() - sentAt >= OUTBOUND_DEDUP_TTL_MS) {
      recentOutbound.delete(key)
      return false
    }
    return true
  }

  // Inbound message dedup. Split check/record (rather than check-and-record in
  // one) so the key is claimed ONLY after we have real content to forward.
  // WhatsApp re-delivers a message several times while the Signal session
  // settles — the early attempts can arrive undecryptable (empty `message`,
  // "Bad MAC") and the SUCCESSFUL decrypt comes last. Recording dedup on a
  // failed/empty attempt would make that successful decrypt look like a
  // duplicate and get dropped, so a real message never forwards. We therefore
  // mark the key at the forward point, after text extraction succeeds.
  const recentInbound = new Set<string>()

  function seenInbound(key: string): boolean {
    return recentInbound.has(key)
  }

  function markInbound(key: string): void {
    if (recentInbound.has(key)) return
    recentInbound.add(key)
    if (recentInbound.size > 1000) {
      const first = recentInbound.values().next().value!
      recentInbound.delete(first)
    }
  }

  // ── Forward inbound to sidanclaw-api ──

  async function forwardToApi(message: WhatsAppIncomingMessage) {
    try {
      const res = await fetch(`${apiUrl}/internal/whatsapp/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Secret': connectorSecret,
        },
        body: JSON.stringify(message),
      })
      if (!res.ok) {
        console.error(`[socket-manager] API inbound forward failed: ${res.status} ${res.statusText}`)
      }
    } catch (err) {
      console.error('[socket-manager] API inbound forward error:', err)
    }
  }

  // ── Stream large inbound media straight to GCS (channel-media-ingest) ──
  // Over the inline cap we don't buffer + base64 (that path drops >cap media).
  // Instead: ask the API for a signed PUT URL, then pipe the Baileys media stream
  // to it — the bytes never sit in connector memory. Returns the GCS reference to
  // relay, or throws so the caller degrades to placeholder text.
  async function streamMediaToGcs(
    channelId: string,
    msg: WAMessage,
    mediaInfo: { mimeType: string; fileName?: string; fileLength?: number },
  ): Promise<NonNullable<WhatsAppIncomingMessage['mediaRef']>> {
    const res = await fetch(`${apiUrl}/internal/whatsapp/media-upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connector-Secret': connectorSecret },
      body: JSON.stringify({ channelId, mime: mediaInfo.mimeType, fileName: mediaInfo.fileName ?? null }),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`media-upload-url failed: ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
    }
    const { gcsKey, uploadUrl, storageUri } = (await res.json()) as { gcsKey: string; uploadUrl: string; storageUri?: string }

    const stream = (await downloadMediaMessage(msg, 'stream', {})) as unknown as import('node:stream').Readable
    const headers: Record<string, string> = { 'Content-Type': mediaInfo.mimeType }
    if (mediaInfo.fileLength) headers['Content-Length'] = String(mediaInfo.fileLength)
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers,
      body: stream as unknown as ReadableStream,
      duplex: 'half', // Node streaming request body requires half-duplex.
    } as RequestInit & { duplex: 'half' })
    if (!put.ok) throw new Error(`GCS PUT failed: ${put.status} ${put.statusText}`)

    return {
      gcsKey,
      // Echo the BYO storage URI back with the bytes so the API stamps the exact
      // bucket the bytes were PUT to (race-free vs. recomputing at /inbound).
      ...(storageUri ? { storageUri } : {}),
      mimeType: mediaInfo.mimeType,
      ...(mediaInfo.fileName ? { fileName: mediaInfo.fileName } : {}),
      ...(mediaInfo.fileLength ? { sizeBytes: mediaInfo.fileLength } : {}),
    }
  }

  // ── Notify the API a channel was logged out ──
  // On a 401 logout the creds are dead and we've purged them; tell the API so
  // it can flip the integration to 'revoked' (the UI then stops showing the
  // number connected and prompts a reconnect). Best-effort — a missed notify
  // only leaves the UI stale until the next status poll/reconnect.
  async function notifyDisconnected(channelId: string, reason: string) {
    try {
      await fetch(`${apiUrl}/internal/whatsapp/disconnected`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Secret': connectorSecret,
        },
        body: JSON.stringify({ channelId, reason }),
      })
    } catch (err) {
      console.error('[socket-manager] disconnect notify error:', err)
    }
  }

  // ── Notify the API the bot was added to / removed from a group ──
  // Drives official-bot group ingest: when the bot's OWN number is added to a
  // group, the API binds that group to whoever added it (`actorJid`) and starts
  // ingesting; on removal it stops. Fired for every channel — the API decides
  // whether the channel is the official shared bot (BYON channels ignore it).
  // Best-effort: a missed add can be re-triggered by re-adding the bot.
  async function forwardGroupEvent(event: {
    channelId: string
    groupJid: string
    action: 'added' | 'removed'
    actorJid?: string
  }) {
    try {
      const res = await fetch(`${apiUrl}/internal/whatsapp/group-event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connector-Secret': connectorSecret,
        },
        body: JSON.stringify(event),
      })
      if (!res.ok) {
        console.error(`[socket-manager] API group-event forward failed: ${res.status} ${res.statusText}`)
      }
    } catch (err) {
      console.error('[socket-manager] API group-event forward error:', err)
    }
  }

  // ── Handle a group-participants change (official-bot binding signal) ──
  // We only care when the bot's OWN jid is the participant added/removed — that
  // is the "added to a group" / "removed from a group" signal. Other members
  // joining/leaving, and promote/demote, are ignored. `update.author` is who
  // performed the action — the adder whose identity the ingest follows.
  // Baileys v7: participants are Contact objects (`id` may be a LID with a
  // paired `phoneNumber`), and the author comes with an `authorPn` PN twin.
  // The adder is forwarded in PN form — linked accounts store PN jids.
  async function handleGroupParticipantsUpdate(
    channelId: string,
    sock: WASocket,
    update: {
      id?: string
      author?: string
      authorPn?: string
      participants?: Array<string | { id: string; lid?: string; phoneNumber?: string }>
      action?: string
    },
  ) {
    const { id: groupJid, author, authorPn, participants, action } = update
    if (!groupJid || (action !== 'add' && action !== 'remove')) return
    const selfIds = [sock.user?.id, (sock.user as { lid?: string } | undefined)?.lid]
      .filter((j): j is string => !!j)
      .map((j) => jidNormalizedUser(j))
    if (selfIds.length === 0) return
    const participantIds = (participants ?? []).flatMap((p) =>
      typeof p === 'string' ? [p] : [p.id, p.lid, p.phoneNumber].filter((j): j is string => !!j),
    )
    const botAffected = participantIds.some((p) => selfIds.includes(jidNormalizedUser(p)))
    if (!botAffected) return
    const actor = authorPn ?? author
    await forwardGroupEvent({
      channelId,
      groupJid,
      action: action === 'add' ? 'added' : 'removed',
      actorJid: actor ? jidNormalizedUser(actor) : undefined,
    })
  }

  // ── Create socket (ported from OpenClaw session.ts createWaSocket) ──

  async function createSocket(
    channelId: string,
    backend: CredBackend,
    listeners?: {
      onQr?: QrListener
      onConnected?: ConnectedListener
      onError?: ErrorListener
    },
  ): Promise<ManagedSocket> {
    const logger = pino({ level: 'silent' })
    // Per-channel credential store: BYON → Postgres, official → GCS, dev → FS.
    const { state, saveCreds } =
      backend === 'postgres'
        ? await usePostgresAuthState(pool!, channelId)
        : backend === 'local'
          ? await useMultiFileAuthState(join(LOCAL_CREDS_DIR!, channelId))
          : await useGCSAuthState(bucket, channelId)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      browser: ['sidanclaw', 'wa-connector', '1.0.0'],
      syncFullHistory: false,
      // `true` keeps the companion presence `available`, so WhatsApp pushes
      // every message in real time as a `notify` upsert — INCLUDING the owner's
      // own messages typed from their primary phone (Baileys flags those
      // `fromMe` and still upserts them). With `false` the companion reports
      // `unavailable` and messages are buffered/delivered late as offline
      // `append` batches, which made own-message capture unreliable. The
      // trade-off is the linked number appears online; we suppress the
      // accompanying read receipts (no blue ticks) by NOT calling
      // `sock.readMessages` on inbound — see handleInboundMessage.
      markOnlineOnConnect: true,
    })

    const managed: ManagedSocket = {
      channelId,
      sock,
      status: 'connecting',
      backend,
    }
    sockets.set(channelId, managed)

    // Wire credential saves
    sock.ev.on('creds.update', () => {
      saveCreds().catch((err) => {
        console.warn(`[socket-manager] creds save failed for ${channelId}:`, err)
      })
    })

    // Connection state handler (ported from OpenClaw session.ts + monitor.ts)
    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      try {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          managed.status = 'qr_pending'
          managed.qr = qr
          listeners?.onQr?.(qr)
        }

        if (connection === 'open') {
          managed.status = 'connected'
          managed.connectedAt = Date.now()
          managed.qr = undefined
          const phone = sock.user?.id?.split(':')[0] ?? sock.user?.id ?? 'unknown'
          managed.phoneNumber = phone
          console.log(`[socket-manager] Connected: ${channelId} (${phone})`)
          listeners?.onConnected?.(phone)

          // Mark presence as available
          sock.sendPresenceUpdate('available').catch(() => {})
        }

        if (connection === 'close') {
          managed.status = 'disconnected'
          // We closed this socket on purpose (replace / disconnect) — just stop,
          // so a connect-replace (e.g. a QR retry) doesn't spawn a competing
          // socket. Do NOT touch the registry here: connect()/disconnect()
          // already manage it, and a replace fires this close asynchronously
          // AFTER the new socket has claimed this channelId, so deleting would
          // evict the replacement.
          if (managed.intentionalClose) return
          const statusCode =
            (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode ??
            (lastDisconnect?.error as { statusCode?: number })?.statusCode

          if (statusCode === LOGGED_OUT_STATUS) {
            console.log(`[socket-manager] Logged out: ${channelId}`)
            sockets.delete(channelId)
            deleteCredsFor(channelId, backend).catch(() => {})
            notifyDisconnected(channelId, 'logged_out').catch(() => {})
            listeners?.onError?.('logged_out')
          } else if (statusCode === 440) {
            // Session conflict — another device claimed the session
            console.log(`[socket-manager] Session conflict (440): ${channelId}`)
            sockets.delete(channelId)
            listeners?.onError?.('session_conflict')
          } else {
            // Reconnect with backoff
            handleReconnect(channelId, 0, backend, listeners)
          }
        }
      } catch (err) {
        console.error(`[socket-manager] connection.update error for ${channelId}:`, err)
      }
    })

    // Handle WebSocket errors to prevent unhandled exceptions
    if (sock.ws && typeof (sock.ws as unknown as { on?: unknown }).on === 'function') {
      ;(sock.ws as unknown as { on: (event: string, listener: (err: Error) => void) => void }).on(
        'error',
        (err: Error) => {
          console.error(`[socket-manager] WebSocket error for ${channelId}:`, err.message)
        },
      )
    }

    // Inbound message handler (ported from OpenClaw inbound/monitor.ts)
    sock.ev.on('messages.upsert', async (upsert: { type?: string; messages?: WAMessage[] }) => {
      // `notify` = new messages from others (the listener's primary path).
      // `append` = messages synced from the owner's other devices; we keep only
      // the owner's OWN recent messages (fromMe + within APPEND_MAX_AGE_MS) so
      // the listener also captures what the owner types from their phone,
      // without re-ingesting replayed history. Everything else in `append` is
      // dropped here before reaching handleInboundMessage.
      const upsertType = upsert.type
      if (upsertType !== 'notify' && upsertType !== 'append') return

      for (const msg of upsert.messages ?? []) {
        if (upsertType === 'append') {
          if (!msg.key?.fromMe) continue
          const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : 0
          if (!ts || Date.now() - ts > APPEND_MAX_AGE_MS) continue
        }
        try {
          await handleInboundMessage(channelId, managed, sock, msg)
        } catch (err) {
          console.error(`[socket-manager] inbound message error for ${channelId}:`, err)
        }
      }
    })

    // Group membership changes — the official-bot "added to a group" signal.
    sock.ev.on('group-participants.update', (update) => {
      handleGroupParticipantsUpdate(channelId, sock, update).catch((err) => {
        console.error(`[socket-manager] group-participants error for ${channelId}:`, err)
      })
    })

    return managed
  }

  // ── Inbound message handler ──

  async function handleInboundMessage(
    channelId: string,
    managed: ManagedSocket,
    sock: WASocket,
    msg: WAMessage,
  ) {
    const id = msg.key?.id
    const remoteJid = msg.key?.remoteJid
    if (!remoteJid || !id) return

    // Skip status/broadcast messages
    if (remoteJid.endsWith('@status') || remoteJid.endsWith('@broadcast')) return

    // Skip self-echoes (ported from OpenClaw inbound/dedupe.ts)
    // Suppress AI self-echoes ONLY — never drop on `fromMe` alone. `fromMe` is
    // true for both bot sends and human messages typed from the connected
    // companion number; the latter are real human messages the listener must
    // still ingest. We drop exclusively when the id matches one we recorded at
    // send time (an AI-generated send echoing back).
    if (msg.key?.fromMe && isRecentOutbound(channelId, id)) return

    // Dedup inbound — check only here; the key is claimed at the forward point
    // below, so an undecryptable early delivery never blocks the later
    // successful decrypt of the same id. See seenInbound/markInbound.
    const dedupeKey = `${channelId}:${remoteJid}:${id}`
    if (seenInbound(dedupeKey)) return

    const isGroup = remoteJid.endsWith('@g.us')
    const participantJid = msg.key?.participant
    const senderJid = isGroup ? participantJid ?? remoteJid : remoteJid

    // LID → PN resolution (Baileys v7). Under WhatsApp's LID privacy
    // addressing the sender arrives as `<id>@lid`, which phone-number-based
    // features (allowlists, linked accounts) cannot match. v7 carries the PN
    // twin on the key (`participantAlt`/`remoteJidAlt`); when absent, ask the
    // synced LID mapping store. Best-effort — early in a session the mapping
    // may not be known yet, and the API logs the unresolvable drop.
    let senderPnJid: string | undefined
    if (senderJid.endsWith('@lid')) {
      const alt = isGroup
        ? (msg.key as { participantAlt?: string }).participantAlt
        : (msg.key as { remoteJidAlt?: string }).remoteJidAlt
      if (alt && !alt.endsWith('@lid')) {
        senderPnJid = jidNormalizedUser(alt)
      } else {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(senderJid)
          if (pn) senderPnJid = jidNormalizedUser(pn)
        } catch {
          // mapping store unavailable — relay without a PN twin
        }
      }
    }

    // Check for message edit (protocol message type 14)
    const editInfo = extractEditedMessage(msg.message ?? undefined)

    // Extract message content. An undecryptable delivery has an empty `message`
    // and yields no text; we return WITHOUT claiming the dedup key so a later
    // decrypted re-delivery of the same id still gets through.
    let text = editInfo?.text ?? extractText(msg.message ?? undefined)
    if (!text) text = extractMediaPlaceholder(msg.message ?? undefined)
    if (!text) return // skip messages with no extractable content

    // We have real content — claim the dedup key now so genuine duplicates of
    // this (already-forwarded) message are suppressed going forward.
    markInbound(dedupeKey)

    // Media handling. Media with a live-turn consumer (images, ptt voice notes,
    // documents) inlines as base64 when under the cap. Video and audio FILES
    // always STREAM straight to GCS and relay as a reference — the API routes
    // them through the channel-media intake (recording / document → brain);
    // inlining them would silently discard the bytes on the BYON path, since
    // nothing reads mediaBase64 there. Over-cap anything streams too. The bytes
    // never sit in connector memory for the streamed path.
    // See shouldStreamMedia (media-routing.ts) + docs/plans/channel-media-ingest.md.
    let mediaBase64: string | undefined
    let mediaMimeType: string | undefined
    let mediaFileName: string | undefined
    let mediaRef: WhatsAppIncomingMessage['mediaRef']

    if (!editInfo && isDownloadableMedia(msg.message ?? undefined)) {
      const mediaInfo = extractMediaInfo(msg.message ?? undefined)
      if (mediaInfo) {
        if (shouldStreamMedia(mediaInfo, MAX_MEDIA_BYTES)) {
          try {
            mediaRef = await streamMediaToGcs(channelId, msg, mediaInfo)
          } catch (err) {
            console.error(`[socket-manager] Media stream-to-GCS failed for ${channelId}:`, err)
            // Fall through with placeholder text — degraded but functional.
          }
        } else {
          try {
            const buffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer
            if (buffer.length <= MAX_MEDIA_BYTES) {
              mediaBase64 = buffer.toString('base64')
              mediaMimeType = mediaInfo.mimeType
              mediaFileName = mediaInfo.fileName
            } else {
              // fileLength under-reported the true size — stream it instead of dropping.
              try {
                mediaRef = await streamMediaToGcs(channelId, msg, mediaInfo)
              } catch (err) {
                console.error(`[socket-manager] Media stream fallback failed for ${channelId}:`, err)
              }
            }
          } catch (err) {
            console.error(`[socket-manager] Media download failed for ${channelId}:`, err)
          }
        }
      }
    }

    const replyContext = editInfo
      ? null // edits don't carry reply context
      : describeReplyContext(msg.message as import('@whiskeysockets/baileys').proto.IMessage | undefined)

    // Deliberately do NOT mark messages as read. With markOnlineOnConnect:true
    // the companion is `available`, so a `readMessages` call would send an
    // *active* read receipt — a blue tick the sender sees, defeating the silent
    // read-only BYON design. Skipping it keeps the listener invisible (no blue
    // ticks) while still receiving every message in real time.

    const timestamp = msg.messageTimestamp
      ? Number(msg.messageTimestamp) * 1000
      : Date.now()

    const incomingMessage: WhatsAppIncomingMessage = {
      messageId: id,
      channelId,
      chatJid: remoteJid,
      senderJid,
      ...(senderPnJid && { senderPnJid }),
      senderName: msg.pushName ?? undefined,
      text,
      isGroup,
      timestamp,
      quotedMessageId: replyContext?.id,
      quotedBody: replyContext?.body,
      ...(editInfo && { isEdit: true, editedMessageId: editInfo.editedMessageId }),
      ...(mediaBase64 && { mediaBase64, mediaMimeType, mediaFileName }),
      ...(mediaRef && { mediaRef }),
    }

    await forwardToApi(incomingMessage)
  }

  // ── Reconnection with exponential backoff ──

  function handleReconnect(
    channelId: string,
    attempt: number,
    backend: CredBackend,
    listeners?: {
      onQr?: QrListener
      onConnected?: ConnectedListener
      onError?: ErrorListener
    },
  ) {
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[socket-manager] Max reconnect attempts reached for ${channelId}`)
      sockets.delete(channelId)
      listeners?.onError?.('max_reconnect_attempts')
      return
    }

    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(RECONNECT_FACTOR, attempt), RECONNECT_MAX_MS)
    console.log(`[socket-manager] Reconnecting ${channelId} in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`)

    setTimeout(async () => {
      try {
        await createSocket(channelId, backend, {
          ...listeners,
          onError: (error) => {
            if (error === 'logged_out' || error === 'session_conflict') {
              listeners?.onError?.(error)
            }
            // For other errors, the socket's connection.update will trigger reconnect
          },
        })
      } catch (err) {
        console.error(`[socket-manager] Reconnect failed for ${channelId}:`, err)
        handleReconnect(channelId, attempt + 1, backend, listeners)
      }
    }, delay)
  }

  // ── Public API ──

  return {
    async connect(channelId, listeners, backend) {
      const resolved = resolveBackend(backend)
      // Close existing socket if any. Mark it intentional so its close handler
      // doesn't reconnect and race the replacement (the QR-retry storm).
      const existing = sockets.get(channelId)
      if (existing) {
        existing.intentionalClose = true
        try {
          existing.sock.end(undefined)
        } catch {
          // ignore
        }
        sockets.delete(channelId)
      }

      return createSocket(channelId, resolved, listeners)
    },

    async disconnect(channelId, deleteCreds = false) {
      const managed = sockets.get(channelId)
      // Backend defaults to GCS when the socket is already gone — only official
      // (GCS) callers pass deleteCreds today; BYON deletion happens on logout
      // where the live socket carries its backend.
      const backend: CredBackend = managed?.backend ?? 'gcs'
      if (managed) {
        managed.intentionalClose = true
        try {
          managed.sock.end(undefined)
        } catch {
          // ignore
        }
        sockets.delete(channelId)
      }

      await drainSaveQueue(channelId, backend)

      if (deleteCreds) {
        await deleteCredsFor(channelId, backend)
      }
    },

    async disconnectAll() {
      const promises: Promise<void>[] = []
      for (const [id, managed] of sockets) {
        managed.intentionalClose = true
        try {
          managed.sock.end(undefined)
        } catch {
          // ignore
        }
        promises.push(drainSaveQueue(id, managed.backend))
      }
      sockets.clear()
      await Promise.all(promises)
    },

    async send(channelId, jid, content) {
      const managed = resolveManaged(channelId)
      if (!managed || managed.status !== 'connected') {
        throw new Error(`No active WhatsApp connection for channel ${channelId}`)
      }
      // Alias sends must dedup + log under the REAL channel id.
      channelId = managed.channelId

      // Send typing indicator
      try {
        await managed.sock.sendPresenceUpdate('composing', jid)
      } catch {
        // best effort
      }

      const result = await managed.sock.sendMessage(jid, content)
      const messageId = result?.key?.id ?? 'unknown'

      // Record this AI-generated send so its inbound echo is suppressed.
      rememberOutbound(channelId, messageId)

      return { messageId }
    },

    async listGroups(channelId) {
      const managed = sockets.get(channelId)
      if (!managed || managed.status !== 'connected') {
        throw new Error(`No active WhatsApp connection for channel ${channelId}`)
      }
      // Baileys returns a record keyed by group jid; project to
      // {jid, subject, participants}. v7 participants are Contacts whose `id`
      // may be a LID (`<id>@lid`) with the phone number on the `phoneNumber`
      // twin — include both so the API side (which normalizes to phone
      // digits) can match hidden-number members too.
      const groups = (await managed.sock.groupFetchAllParticipating()) as Record<
        string,
        { id: string; subject?: string; participants?: { id: string; phoneNumber?: string }[] }
      >
      return Object.values(groups).map((g) => ({
        jid: g.id,
        subject: g.subject ?? '',
        participants: (g.participants ?? []).flatMap((p) =>
          [p.id, p.phoneNumber].filter((j): j is string => !!j),
        ),
      }))
    },

    async groupLeave(channelId, groupJid) {
      const managed = sockets.get(channelId)
      if (!managed || managed.status !== 'connected') {
        throw new Error(`No active WhatsApp connection for channel ${channelId}`)
      }
      await managed.sock.groupLeave(groupJid)
    },

    getStatus(channelId) {
      return sockets.get(channelId)
    },

    listConnections() {
      return [...sockets.values()].map((s) => ({
        channelId: s.channelId,
        status: s.status,
        ...(s.phoneNumber ? { phoneNumber: s.phoneNumber } : {}),
        backend: s.backend,
        ...(s.connectedAt ? { connectedAt: s.connectedAt } : {}),
      }))
    },

    async restoreAll() {
      // Official channels (GCS). Local-dev FS mode skips this — official creds
      // live on ephemeral disk there, so pair fresh via QR.
      if (!LOCAL_CREDS_DIR) {
        const gcsIds = await listStoredChannels(bucket)
        console.log(`[socket-manager] Found ${gcsIds.length} GCS (official) credentials to restore`)
        for (const channelId of gcsIds) {
          try {
            console.log(`[socket-manager] Restoring GCS socket for ${channelId}`)
            await createSocket(channelId, 'gcs')
          } catch (err) {
            console.error(`[socket-manager] Failed to restore GCS socket for ${channelId}:`, err)
          }
        }
      } else {
        console.log('[socket-manager] WA_LOCAL_CREDS_DIR set — skipping GCS/FS restore (official)')
      }

      // BYON channels (Postgres). Restored in both dev and prod when a pool is
      // configured — DB persistence survives a wa-connector restart everywhere.
      if (pool) {
        const dbIds = await listStoredChannelsPg(pool)
        console.log(`[socket-manager] Found ${dbIds.length} Postgres (BYON) credentials to restore`)
        for (const channelId of dbIds) {
          try {
            console.log(`[socket-manager] Restoring Postgres socket for ${channelId}`)
            await createSocket(channelId, 'postgres')
          } catch (err) {
            console.error(`[socket-manager] Failed to restore Postgres socket for ${channelId}:`, err)
          }
        }
      }
    },
  }
}
