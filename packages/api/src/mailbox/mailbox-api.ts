/**
 * `MailboxApi` seam implementation over imapflow + nodemailer + mailparser.
 *
 * Core (`packages/core/src/tools/base/mailbox.ts`) owns search policy
 * (window/cap defaults, thread stitching); this module owns the mechanism:
 * folder scope resolution (every selectable ordinary folder by default), the
 * server-side OR-tree search with the BADCHARSET client-side fallback,
 * bounded snippet fetches, MIME/charset decode (mailparser — load-bearing
 * for Chinese enterprise mail), reply threading headers, and the best-effort
 * Sent-copy APPEND after SMTP submission.
 *
 * Spec: docs/architecture/integrations/mailbox-imap.md.
 * [COMP:api/mailbox-imap-client]
 */

import { simpleParser, type ParsedMail } from 'mailparser'
import {
  MAILBOX_ATTACHMENT_MAX_BYTES,
  MAILBOX_DEFAULT_WINDOW_DAYS,
  type MailboxApi,
  type MailboxAttachment,
  type MailboxAttachmentBytes,
  type MailboxMessage,
  type MailboxSearchHit,
  type MailboxSearchParams,
} from '@use-brian/core'
import { buildImapSearchQuery, hasNonAsciiTerm } from './search-criteria.js'
import {
  defaultMailboxSessionCache,
  syncableFolders,
  type ImapBodyStructureNode,
  type ImapClientLike,
  type ImapFetchedMessage,
  type MailboxSessionCache,
} from './imap-session.js'
import { composeMailboxMessage, sendComposedMessage } from './smtp.js'
import { bareEmailAddress, senderIdentities } from './send-as.js'
import type { MailboxAccountSettings } from './types.js'
import { isAliMailImapHost } from './presets.js'

const SNIPPET_SOURCE_BYTES = 16 * 1024
const FULL_MESSAGE_SOURCE_BYTES = 4 * 1024 * 1024
/** Degraded (client-side) filtering scans at most this many recent headers. */
const DEGRADED_SCAN_CAP = 200

/** Sent-folder name fallbacks when the server advertises no SPECIAL-USE \Sent. */
const SENT_NAME_CANDIDATES = ['sent', 'sent messages', 'sent items', '已发送', '已发送邮件', '寄件備份']

export function messageRef(folder: string, uid: number): string {
  return `${folder}:${uid}`
}

/** Parse a `folder:uid` ref (folder may itself contain `:` — uid is the last segment). */
export function parseMessageRef(ref: string): { folder: string; uid: number } | null {
  const i = ref.lastIndexOf(':')
  if (i <= 0) return null
  const uid = Number(ref.slice(i + 1))
  if (!Number.isInteger(uid) || uid <= 0) return null
  return { folder: ref.slice(0, i), uid }
}

function formatAddress(a: { name?: string; address?: string } | undefined): string {
  if (!a) return ''
  if (a.name && a.address) return `${a.name} <${a.address}>`
  return a.address ?? a.name ?? ''
}

function formatAddressList(list: Array<{ name?: string; address?: string }> | undefined): string[] {
  return (list ?? []).map(formatAddress).filter(Boolean)
}

/** Unfold and extract `<...>` message ids from a raw headers buffer. */
export function parseReferencesHeader(headers: Buffer | undefined): string[] {
  if (!headers) return []
  const text = headers.toString('utf8')
  const match = text.match(/^references:((?:.*(?:\r?\n[ \t].*)*))/im)
  if (!match) return []
  return [...match[1].matchAll(/<[^<>\s]+>/g)].map((m) => m[0])
}

/** Minimal HTML → text fallback for messages with no text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// ── Attachment listing from BODYSTRUCTURE (D14) ───────────────────────────
//
// The server's own part tree is the ONLY authority for part ids and for what
// a message actually carries. mailparser is not: it numbers parts by raw
// stream boundaries rather than the IMAP tree (wrong part on nested
// multiparts — `related` inside `alternative` inside `mixed`, the airline
// shape), and it only ever sees the first FULL_MESSAGE_SOURCE_BYTES of a
// large message, so its listing silently goes short. BODYSTRUCTURE is
// metadata, so fetching it has no size-cap exposure at all.

/** Body-text leaves with no disposition are the message, not attachments. */
function isBodyTextNode(node: ImapBodyStructureNode): boolean {
  const type = (node.type ?? '').toLowerCase()
  return !node.disposition && (type === 'text/plain' || type === 'text/html')
}

function attachmentFilename(node: ImapBodyStructureNode): string | undefined {
  return node.dispositionParameters?.filename ?? node.parameters?.name
}

/**
 * Walk the part tree and collect every attachment-ish leaf: anything
 * explicitly dispositioned (`attachment` or `inline` — inline images are
 * exactly the boarding-pass case) or carrying a filename. Multipart nodes
 * are containers; only leaves are downloadable parts.
 */
export function collectAttachmentParts(
  node: ImapBodyStructureNode | undefined,
  out: MailboxAttachment[] = [],
): MailboxAttachment[] {
  if (!node) return out
  if (node.childNodes?.length) {
    for (const child of node.childNodes) collectAttachmentParts(child, out)
    return out
  }
  if (!node.part) return out  // root of a single-part message = the body itself
  if (isBodyTextNode(node)) return out
  const disposition = (node.disposition ?? '').toLowerCase()
  const filename = attachmentFilename(node)
  const isAttachment = disposition === 'attachment' || disposition === 'inline' || Boolean(filename)
  if (!isAttachment) return out
  out.push({
    filename: filename ?? `part-${node.part}`,
    mime: (node.type ?? 'application/octet-stream').toLowerCase(),
    size: node.size ?? 0,
    partId: node.part,
  })
  return out
}

/** Find one part by its dotted IMAP part number. */
export function findPartNode(
  node: ImapBodyStructureNode | undefined,
  partId: string,
): ImapBodyStructureNode | null {
  if (!node) return null
  if (node.part === partId) return node
  for (const child of node.childNodes ?? []) {
    const hit = findPartNode(child, partId)
    if (hit) return hit
  }
  return null
}

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

/**
 * Buffer a part stream, aborting the moment the running total passes the cap.
 * The BODYSTRUCTURE pre-check above is advisory — a server may under-report or
 * omit `size` — so the byte count is what actually enforces D16.
 */
async function bufferCapped(
  content: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
  cap: number,
  filename: string,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of content) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > cap) {
      content.destroy?.()
      throw new Error(
        `Attachment "${filename}" is larger than the ${formatMb(cap)} limit, so it cannot be saved to the workspace. Ask the user to download it from their mail client instead.`,
      )
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function resolveSentPath(client: ImapClientLike): Promise<string | null> {
  let folders: Array<{ path: string; specialUse?: string }>
  try {
    folders = await client.list()
  } catch {
    return null
  }
  const special = folders.find((f) => f.specialUse === '\\Sent')
  if (special) return special.path
  for (const candidate of SENT_NAME_CANDIDATES) {
    const hit = folders.find((f) => {
      const leaf = f.path.split(/[/.]/).pop() ?? f.path
      return leaf.toLowerCase() === candidate
    })
    if (hit) return hit.path
  }
  return null
}

function hitFromFetched(folder: string, msg: ImapFetchedMessage): MailboxSearchHit {
  const env = msg.envelope ?? {}
  const date = env.date ?? msg.internalDate ?? null
  // A malformed Date: header must degrade to null, never crash the search.
  const dateMs = date ? new Date(date).getTime() : NaN
  return {
    id: messageRef(folder, msg.uid),
    folder,
    from: formatAddress(env.from?.[0]),
    to: formatAddressList(env.to),
    date: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
    subject: env.subject ?? '',
    messageId: env.messageId ?? null,
    inReplyTo: env.inReplyTo ?? null,
    references: parseReferencesHeader(msg.headers),
  }
}

function matchesDegraded(hit: MailboxSearchHit, params: MailboxSearchParams): boolean {
  const haystack = `${hit.subject}\n${hit.from}`.toLowerCase()
  if (params.from && !hit.from.toLowerCase().includes(params.from.toLowerCase())) return false
  if (params.subject && !hit.subject.toLowerCase().includes(params.subject.toLowerCase())) return false
  const keywords = (params.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean)
  if (keywords.length === 0) return true
  return keywords.some((k) => haystack.includes(k))
}

function hasSelectiveTextSearch(params: MailboxSearchParams): boolean {
  return Boolean(
    params.from?.trim() ||
    params.subject?.trim() ||
    params.keywords?.some((keyword) => keyword.trim()),
  )
}

function messageIdentity(hit: MailboxSearchHit): string {
  const rfcMessageId = hit.messageId?.trim().toLowerCase()
  return rfcMessageId ? `rfc:${rfcMessageId}` : `provider:${hit.id}`
}

function literalMatchTier(hit: MailboxSearchHit, params: MailboxSearchParams): number {
  const from = hit.from.toLowerCase()
  const subject = hit.subject.toLowerCase()
  const snippet = hit.snippet?.toLowerCase() ?? ''
  const keywords = (params.keywords ?? []).map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)

  if (params.from?.trim() && from.includes(params.from.trim().toLowerCase())) return 0
  if (keywords.some((keyword) => from.includes(keyword))) return 0
  if (params.subject?.trim() && subject.includes(params.subject.trim().toLowerCase())) return 1
  if (keywords.some((keyword) => subject.includes(keyword))) return 1
  if (keywords.some((keyword) => snippet.includes(keyword))) return 2
  // A server-side body match can have no bounded snippet (or the matching text
  // can sit beyond it). Keep it after observable literal matches, never drop it.
  return 3
}

/**
 * Fuse the live and literal-archive arms. The current live folder:uid wins for
 * a duplicate, while an archive body snippet can fill a missing live snippet.
 */
export function mergeMailboxSearchHits(input: {
  live: MailboxSearchHit[]
  archive: MailboxSearchHit[]
  params: MailboxSearchParams
}): MailboxSearchHit[] {
  const byIdentity = new Map<string, MailboxSearchHit>()
  for (const hit of input.archive) byIdentity.set(messageIdentity(hit), { ...hit })
  for (const hit of input.live) {
    const key = messageIdentity(hit)
    const archived = byIdentity.get(key)
    byIdentity.set(key, archived
      ? { ...archived, ...hit, snippet: hit.snippet ?? archived.snippet }
      : { ...hit })
  }
  const time = (date: string | null) => date ? Date.parse(date) || 0 : 0
  return [...byIdentity.values()]
    .sort((a, b) =>
      literalMatchTier(a, input.params) - literalMatchTier(b, input.params) ||
      time(b.date) - time(a.date) ||
      a.id.localeCompare(b.id),
    )
    .slice(0, input.params.limit)
}

async function fetchHitsForUids(
  client: ImapClientLike,
  folder: string,
  uids: number[],
): Promise<MailboxSearchHit[]> {
  if (uids.length === 0) return []
  const hits: MailboxSearchHit[] = []
  for await (const msg of client.fetch(
    uids.join(','),
    { envelope: true, internalDate: true, headers: ['references'] },
    { uid: true },
  )) {
    hits.push(hitFromFetched(folder, msg))
  }
  return hits
}

async function fetchSnippet(
  client: ImapClientLike,
  uid: number,
): Promise<string | undefined> {
  try {
    const msg = await client.fetchOne(
      String(uid),
      { source: { start: 0, maxLength: SNIPPET_SOURCE_BYTES } },
      { uid: true },
    )
    if (!msg || !msg.source) return undefined
    const parsed = await simpleParser(msg.source)
    const text = parsed.text ?? (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')
    const collapsed = collapseWhitespace(text)
    return collapsed || undefined
  } catch {
    return undefined
  }
}

type FolderSearchOutcome = {
  hits: MailboxSearchHit[]
  degraded: 'charset' | 'alimail-empty' | null
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function searchFolder(
  client: ImapClientLike,
  folder: string,
  params: MailboxSearchParams,
  recoverAliMailEmpty: boolean,
): Promise<FolderSearchOutcome> {
  const lock = await client.getMailboxLock(folder)
  try {
    let uids: number[] | false = false
    let degraded: FolderSearchOutcome['degraded'] = null
    try {
      uids = await client.search(buildImapSearchQuery(params), { uid: true })
    } catch (err) {
      if (!hasNonAsciiTerm(params)) throw err
      // BADCHARSET-class failure: the server refused the UTF-8 criteria.
      // Fall back to a date-bounded header scan filtered client-side
      // (bounded — subject/sender matching only, plan §4).
      degraded = 'charset'
      uids = await client.search(
        buildImapSearchQuery({ since: params.since, before: params.before, limit: params.limit }),
        { uid: true },
      )
    }
    if ((!uids || uids.length === 0) && recoverAliMailEmpty) {
      degraded = 'alimail-empty'
      uids = await client.search(
        buildImapSearchQuery({
          since: params.since ?? isoDaysAgo(MAILBOX_DEFAULT_WINDOW_DAYS),
          before: params.before,
          limit: params.limit,
        }),
        { uid: true },
      )
    }
    if (!uids || uids.length === 0) return { hits: [], degraded }

    if (degraded === null) {
      const capped = uids.slice(-params.limit)
      const hits = await fetchHitsForUids(client, folder, capped)
      return { hits, degraded }
    }

    const scan = uids.slice(-DEGRADED_SCAN_CAP)
    const scanned = await fetchHitsForUids(client, folder, scan)
    const filtered = scanned.filter((h) => matchesDegraded(h, params)).slice(-params.limit)
    return { hits: filtered, degraded }
  } finally {
    lock.release()
  }
}

export type CreateMailboxApiOptions = {
  /** Session-cache key — the connector instance id. */
  cacheKey: string
  /** Lazy credential resolution (the `getPat` pattern — resolved per call). */
  getSettings: () => Promise<MailboxAccountSettings>
  /**
   * Durable cursor/archive folder paths used when a successful LIST response
   * is temporarily truncated. Paths that raw LIST explicitly marks special
   * or non-selectable are still excluded.
   */
  getKnownFolderPaths?: () => Promise<string[]>
  /** Owner-scoped literal arm over the synced archive; needs no embeddings. */
  searchArchivedMessages?: (params: MailboxSearchParams) => Promise<MailboxSearchHit[]>
  sessions?: MailboxSessionCache
  /**
   * APPEND the sent bytes to the IMAP Sent folder after SMTP submission
   * (provider-aware default: true for most corporate servers, false for
   * smtp.gmail.com because Gmail auto-saves submitted mail). Explicit values
   * override the default for tests and future presets.
   */
  saveSentCopy?: boolean
  /** SMTP submission override (test seam). Defaults to the real transport. */
  sendComposed?: typeof sendComposedMessage
  /**
   * The mailbox's configured send-as aliases (`config.sendAsAliases`, read by
   * the injector from the instance row). Resolved per call like `getSettings`
   * so a panel edit applies to the next send. Absent = the account is the only
   * sender identity (today's behaviour).
   */
  getSendAsAliases?: () => Promise<string[]>
}

/** What a reply needs from the replied-to message: threading ids + who it was addressed to. */
type ReplyTarget = {
  messageId: string | null
  references: string[]
  /** Bare lowercased `To ∪ Cc` of the original, in envelope order. */
  recipients: string[]
}

/**
 * Sender resolution (mailbox-imap.md → "Send-as aliases", D4):
 *   1. explicit `from` → must be the account or a configured alias, else an
 *      honest bounded refusal listing what IS allowed (the model cannot invent
 *      a sender);
 *   2. else a reply → the first configured ALIAS found among the original's
 *      To/Cc ("reply from the address it was written to");
 *   3. else the account.
 * Exported for tests; `resolveSender` and `sendMessage` share it so the
 * confirmation preview can never disagree with the send.
 */
export function resolveSenderAddress(params: {
  accountEmail: string
  aliases: ReadonlyArray<string>
  from?: string
  replyRecipients?: ReadonlyArray<string>
}): { from: string; allowed: string[] } {
  const allowed = senderIdentities(params.accountEmail, params.aliases)
  const account = allowed[0]
  if (params.from !== undefined && params.from.trim() !== '') {
    const wanted = bareEmailAddress(params.from)
    if (!allowed.includes(wanted)) {
      throw new Error(
        `"${params.from.trim()}" is not an address this email account can send as. ` +
        `Allowed senders: ${allowed.join(', ')}. Omit \`from\` to reply from the address the original was sent to.`,
      )
    }
    return { from: wanted, allowed }
  }
  const aliases = allowed.slice(1)
  for (const recipient of params.replyRecipients ?? []) {
    const bare = bareEmailAddress(recipient)
    if (aliases.includes(bare)) return { from: bare, allowed }
  }
  return { from: account, allowed }
}

export function createMailboxApi(opts: CreateMailboxApiOptions): MailboxApi {
  const sessions = opts.sessions ?? defaultMailboxSessionCache
  const sendComposed = opts.sendComposed ?? sendComposedMessage
  const getSendAsAliases = opts.getSendAsAliases ?? (async () => [])

  // Fetch the replied-to message's envelope: the RFC ids live on the server,
  // not in the model's input, and its To/Cc decide the reply-from-origin
  // sender. One fetch serves both.
  async function fetchReplyTarget(settings: MailboxAccountSettings, inReplyTo: string): Promise<ReplyTarget> {
    const ref = parseMessageRef(inReplyTo)
    if (!ref) {
      throw new Error(
        `Invalid inReplyTo "${inReplyTo}" — expected the folder:uid shape from imapSearchMessages.`,
      )
    }
    return sessions.withClient(opts.cacheKey, settings, async (client) => {
      const lock = await client.getMailboxLock(ref.folder)
      try {
        const msg = await client.fetchOne(
          String(ref.uid),
          { envelope: true, headers: ['references'] },
          { uid: true },
        )
        if (!msg) throw new Error(`Message ${inReplyTo} not found — cannot thread the reply.`)
        const targetId = msg.envelope?.messageId ?? null
        const recipients = [...(msg.envelope?.to ?? []), ...(msg.envelope?.cc ?? [])]
          .map((a) => bareEmailAddress(a.address ?? ''))
          .filter(Boolean)
        return {
          messageId: targetId,
          references: targetId ? [...parseReferencesHeader(msg.headers), targetId] : [],
          recipients,
        }
      } finally {
        lock.release()
      }
    })
  }

  return {
    async resolveSender(params) {
      const settings = await opts.getSettings()
      const aliases = await getSendAsAliases()
      // An explicit `from` never needs the envelope; only reply-from-origin
      // does, and only when there is at least one alias to pick.
      const needsEnvelope = !(params.from && params.from.trim()) && Boolean(params.inReplyTo) && aliases.length > 0
      const target = needsEnvelope ? await fetchReplyTarget(settings, params.inReplyTo!) : null
      return resolveSenderAddress({
        accountEmail: settings.email,
        aliases,
        ...(params.from ? { from: params.from } : {}),
        ...(target ? { replyRecipients: target.recipients } : {}),
      })
    },

    async searchMessages(params) {
      const settings = await opts.getSettings()
      const literalSearch = hasSelectiveTextSearch(params)
      const archiveParams: MailboxSearchParams = {
        ...params,
        since: params.archiveSince === null ? undefined : params.archiveSince ?? params.since,
      }
      const archivePromise = literalSearch && opts.searchArchivedMessages
        ? Promise.resolve()
          .then(() => opts.searchArchivedMessages!(archiveParams))
          .then((hits) => ({ attempted: true, hits, error: null as unknown }))
          .catch((error: unknown) => ({ attempted: true, hits: [] as MailboxSearchHit[], error }))
        : Promise.resolve({ attempted: false, hits: [] as MailboxSearchHit[], error: null as unknown })

      let live: {
        hits: MailboxSearchHit[]
        outcomes: FolderSearchOutcome[]
        folderFailures: unknown[]
        error: unknown
      }
      try {
        const result = await sessions.withClient(opts.cacheKey, settings, async (client) => {
          let folders: string[]
          if (params.folder) {
            folders = [params.folder]
          } else {
            const listed = await client.list()
            const listedPaths = new Set(listed.map((folder) => folder.path))
            const knownFolderPaths = await opts.getKnownFolderPaths?.() ?? []
            folders = [...new Set([
              ...syncableFolders(listed).map((folder) => folder.path),
              // Only recover paths absent from raw LIST. A known path that LIST
              // returned as Junk/Trash/Drafts/All/non-selectable is an explicit
              // exclusion, not a truncated-list candidate.
              ...knownFolderPaths.filter((path) => path.length > 0 && !listedPaths.has(path)),
            ])]
          }

          const outcomes: FolderSearchOutcome[] = []
          const folderFailures: unknown[] = []
          for (const folder of folders) {
            try {
              outcomes.push(await searchFolder(
                client,
                folder,
                params,
                isAliMailImapHost(settings.imapHost) && literalSearch,
              ))
            } catch (err) {
              // An explicit scope has no useful partial answer. For the default
              // whole-mailbox scope, keep healthy custom folders searchable but
              // never turn a total provider failure into an honest-looking
              // empty result.
              if (params.folder || (err as { authenticationFailed?: boolean })?.authenticationFailed) throw err
              folderFailures.push(err)
            }
          }
          if (folderFailures.length > 0 && outcomes.length === 0) throw folderFailures[0]

          const time = (date: string | null) => date ? Date.parse(date) || 0 : 0
          const hits = outcomes
            .flatMap((outcome) => outcome.hits)
            .sort((a, b) => time(b.date) - time(a.date))
            .slice(0, params.limit)

          // Fetch snippets only for the bounded live arm. Archive hits already
          // carry a body snippet and their folder:uid may be stale after a move.
          for (const hit of hits) {
            const ref = parseMessageRef(hit.id)
            if (!ref) continue
            const lock = await client.getMailboxLock(ref.folder)
            try {
              hit.snippet = await fetchSnippet(client, ref.uid)
            } finally {
              lock.release()
            }
          }
          return { hits, outcomes, folderFailures }
        })
        live = { ...result, error: null }
      } catch (error) {
        live = { hits: [], outcomes: [], folderFailures: [], error }
      }

      const archive = await archivePromise
      const authenticationFailed = Boolean((live.error as { authenticationFailed?: boolean } | null)?.authenticationFailed)
      if (live.error && (params.folder || authenticationFailed || archive.hits.length === 0)) throw live.error

      const merged = mergeMailboxSearchHits({ live: live.hits, archive: archive.hits, params })
      const liveIdentities = new Set(live.hits.map(messageIdentity))
      const archiveOnlyCount = merged.filter((hit) => !liveIdentities.has(messageIdentity(hit))).length
      const notes: string[] = []
      if (live.outcomes.some((outcome) => outcome.degraded === 'charset')) {
        notes.push(
          'The mail server rejected the non-ASCII search terms, so recent subjects and senders were filtered client-side; the synced archive was also searched literally for body matches.',
        )
      }
      if (live.outcomes.some((outcome) => outcome.degraded === 'alimail-empty')) {
        notes.push(
          'AliMail returned an empty selective search, so recent message envelopes were filtered client-side; the synced archive was also searched literally for body matches.',
        )
      }
      if (live.error && archive.hits.length > 0) {
        notes.push(
          'The live mailbox search failed, so these matches came from the synced personal archive; current folder locations and unsynced mail may be incomplete.',
        )
      } else if (archive.error) {
        notes.push(
          'The synced personal archive could not be searched, so the live results may be incomplete.',
        )
      } else if (archiveOnlyCount > 0) {
        notes.push(
          'Results include literal matches from the synced personal archive; archive rows may lag or carry a stale folder:uid if a message moved after sync.',
        )
      } else if (archive.attempted && merged.length === 0) {
        notes.push(
          'The live mailbox and synced personal archive found no literal match; if history sync is incomplete, older unsynced mail remains inconclusive.',
        )
      }
      if (live.folderFailures.length > 0) {
        notes.push(
          `${live.folderFailures.length} mailbox folder(s) could not be searched, so these results may be incomplete.`,
        )
      }
      return { hits: merged, ...(notes.length ? { note: notes.join(' ') } : {}) }
    },

    async getMessage(id) {
      const ref = parseMessageRef(id)
      if (!ref) throw new Error(`Invalid message id "${id}" — expected the folder:uid shape from imapSearchMessages.`)
      const settings = await opts.getSettings()
      return sessions.withClient(opts.cacheKey, settings, async (client) => {
        const lock = await client.getMailboxLock(ref.folder)
        let parsed: ParsedMail
        let fetched: ImapFetchedMessage
        try {
          const msg = await client.fetchOne(
            String(ref.uid),
            // bodyStructure rides along: metadata-only, and it is what the
            // attachment listing is derived from (D14) — never the capped
            // source below, whose parse goes blind past 4 MB.
            { envelope: true, bodyStructure: true, source: { start: 0, maxLength: FULL_MESSAGE_SOURCE_BYTES } },
            { uid: true },
          )
          if (!msg || !msg.source) throw new Error(`Message ${id} not found.`)
          fetched = msg
          parsed = await simpleParser(msg.source)
        } finally {
          lock.release()
        }
        const body =
          parsed.text ?? (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')
        const refs = parsed.references
        const message: MailboxMessage = {
          id,
          folder: ref.folder,
          from: parsed.from?.text ?? formatAddress(fetched.envelope?.from?.[0]),
          to: parsed.to
            ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).map((a) => a.text)
            : formatAddressList(fetched.envelope?.to),
          ...(parsed.cc
            ? { cc: (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).map((a) => a.text) }
            : {}),
          date: (parsed.date ?? fetched.envelope?.date)
            ? new Date(parsed.date ?? fetched.envelope!.date!).toISOString()
            : null,
          subject: parsed.subject ?? fetched.envelope?.subject ?? '',
          body,
          attachments: collectAttachmentParts(fetched.bodyStructure),
          messageId: parsed.messageId ?? fetched.envelope?.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? fetched.envelope?.inReplyTo ?? null,
          references: refs ? (Array.isArray(refs) ? refs : [refs]) : [],
        }
        return message
      })
    },

    async getAttachment(id, partId): Promise<MailboxAttachmentBytes> {
      const ref = parseMessageRef(id)
      if (!ref) throw new Error(`Invalid message id "${id}" — expected the folder:uid shape from imapSearchMessages.`)
      const settings = await opts.getSettings()
      return sessions.withClient(opts.cacheKey, settings, async (client) => {
        const lock = await client.getMailboxLock(ref.folder)
        try {
          // 1. Authoritative part metadata. A missing message here is a stale
          //    ref (UIDVALIDITY rotated, message moved or deleted) — say so and
          //    point at the tool that produces fresh ids.
          const msg = await client.fetchOne(String(ref.uid), { bodyStructure: true }, { uid: true })
          if (!msg) {
            throw new Error(
              `Message ${id} is no longer in the mailbox (it may have been moved or deleted). Run imapSearchMessages again to get a current message id.`,
            )
          }
          const node = findPartNode(msg.bodyStructure, partId)
          if (!node) {
            const available = collectAttachmentParts(msg.bodyStructure)
            throw new Error(
              available.length > 0
                ? `Message ${id} has no part "${partId}". Its attachments are: ${available.map((a) => `${a.filename} (partId ${a.partId})`).join(', ')}.`
                : `Message ${id} has no attachments to save.`,
            )
          }
          const filename = attachmentFilename(node) ?? `part-${partId}`

          // 2. Pre-download refusal from metadata — encoded octets, so the
          //    check is conservative (base64 inflates by ~33%). Nothing has
          //    streamed yet at this point.
          if ((node.size ?? 0) > MAILBOX_ATTACHMENT_MAX_BYTES) {
            throw new Error(
              `Attachment "${filename}" is ${formatMb(node.size ?? 0)}, over the ${formatMb(MAILBOX_ATTACHMENT_MAX_BYTES)} limit, so it cannot be saved to the workspace. Ask the user to download it from their mail client instead.`,
            )
          }

          // 3. Stream exactly this part (transfer-encoding decoded by
          //    imapflow), counting bytes as they arrive.
          const download = await client.download(String(ref.uid), partId, { uid: true })
          const bytes = await bufferCapped(download.content, MAILBOX_ATTACHMENT_MAX_BYTES, filename)
          return {
            filename: download.meta?.filename ?? filename,
            mime: (download.meta?.contentType ?? node.type ?? 'application/octet-stream').toLowerCase(),
            bytes,
          }
        } finally {
          lock.release()
        }
      })
    },

    async sendMessage(params) {
      const settings = await opts.getSettings()
      const aliases = await getSendAsAliases()

      // Resolve threading headers + the reply-from-origin recipients from the
      // replied-to message (RFC ids live on the server, not in the model's
      // input). Refuse an explicit disallowed `from` BEFORE any network work.
      const explicitFrom = params.from?.trim() ? params.from.trim() : undefined
      if (explicitFrom) resolveSenderAddress({ accountEmail: settings.email, aliases, from: explicitFrom })
      let inReplyToHeader: string | undefined
      let references: string[] | undefined
      let replyRecipients: string[] | undefined
      if (params.inReplyTo) {
        const target = await fetchReplyTarget(settings, params.inReplyTo)
        if (target.messageId) {
          inReplyToHeader = target.messageId
          references = target.references
        }
        replyRecipients = target.recipients
      }
      // Header From AND envelope MAIL FROM both carry the resolved sender (D5)
      // — bounces route to the alias, which lands in the same mailbox.
      const { from } = resolveSenderAddress({
        accountEmail: settings.email,
        aliases,
        ...(explicitFrom ? { from: explicitFrom } : {}),
        ...(replyRecipients ? { replyRecipients } : {}),
      })

      const composed = await composeMailboxMessage({
        from,
        to: params.to,
        ...(params.cc?.length ? { cc: params.cc } : {}),
        ...(params.bcc?.length ? { bcc: params.bcc } : {}),
        subject: params.subject,
        body: params.body,
        ...(params.attachments?.length ? { attachments: params.attachments } : {}),
        ...(inReplyToHeader ? { inReplyTo: inReplyToHeader } : {}),
        ...(references ? { references } : {}),
      })
      await sendComposed(settings, composed)

      // Best-effort Sent copy — the send already egressed; never fail on this.
      // Gmail auto-saves smtp.gmail.com submissions, so its provider-aware
      // default skips APPEND and avoids a duplicate in Gmail/Sent.
      const saveSentCopy =
        opts.saveSentCopy ??
        settings.smtpHost.trim().toLowerCase().replace(/\.$/, '') !== 'smtp.gmail.com'
      if (saveSentCopy) {
        try {
          await sessions.withClient(opts.cacheKey, settings, async (client) => {
            const sent = await resolveSentPath(client)
            if (sent) await client.append(sent, composed.raw, ['\\Seen'])
          })
        } catch (err) {
          console.warn(
            '[mailbox] Sent-copy APPEND failed (send succeeded):',
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      return { messageId: composed.messageId, from }
    },
  }
}
