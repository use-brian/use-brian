/**
 * `MailboxApi` seam implementation over imapflow + nodemailer + mailparser.
 *
 * Core (`packages/core/src/tools/base/mailbox.ts`) owns search policy
 * (window/cap defaults, thread stitching); this module owns the mechanism:
 * folder scope resolution (INBOX + SPECIAL-USE `\Sent` by default), the
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
  type ImapBodyStructureNode,
  type ImapClientLike,
  type ImapFetchedMessage,
  type MailboxSessionCache,
} from './imap-session.js'
import { composeMailboxMessage, sendComposedMessage } from './smtp.js'
import type { MailboxAccountSettings } from './types.js'

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
  degraded: boolean
}

async function searchFolder(
  client: ImapClientLike,
  folder: string,
  params: MailboxSearchParams,
): Promise<FolderSearchOutcome> {
  const lock = await client.getMailboxLock(folder)
  try {
    let uids: number[] | false = false
    let degraded = false
    try {
      uids = await client.search(buildImapSearchQuery(params), { uid: true })
    } catch (err) {
      if (!hasNonAsciiTerm(params)) throw err
      // BADCHARSET-class failure: the server refused the UTF-8 criteria.
      // Fall back to a date-bounded header scan filtered client-side
      // (bounded — subject/sender matching only, plan §4).
      degraded = true
      uids = await client.search(
        buildImapSearchQuery({ since: params.since, before: params.before, limit: params.limit }),
        { uid: true },
      )
    }
    if (!uids || uids.length === 0) return { hits: [], degraded }

    if (!degraded) {
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
}

export function createMailboxApi(opts: CreateMailboxApiOptions): MailboxApi {
  const sessions = opts.sessions ?? defaultMailboxSessionCache
  const sendComposed = opts.sendComposed ?? sendComposedMessage

  return {
    async searchMessages(params) {
      const settings = await opts.getSettings()
      return sessions.withClient(opts.cacheKey, settings, async (client) => {
        let folders: string[]
        let sentMissing = false
        if (params.folder) {
          folders = [params.folder]
        } else {
          const sent = await resolveSentPath(client)
          folders = sent ? ['INBOX', sent] : ['INBOX']
          sentMissing = !sent
        }

        const outcomes: FolderSearchOutcome[] = []
        for (const folder of folders) {
          outcomes.push(await searchFolder(client, folder, params))
        }

        const time = (d: string | null) => (d ? Date.parse(d) || 0 : 0)
        const merged = outcomes
          .flatMap((o) => o.hits)
          .sort((a, b) => time(b.date) - time(a.date))
          .slice(0, params.limit)

        // Bounded snippet pass over the final result set only.
        for (const hit of merged) {
          const ref = parseMessageRef(hit.id)
          if (!ref) continue
          const lock = await client.getMailboxLock(ref.folder)
          try {
            hit.snippet = await fetchSnippet(client, ref.uid)
          } finally {
            lock.release()
          }
        }

        const notes: string[] = []
        if (outcomes.some((o) => o.degraded)) {
          notes.push(
            'The mail server rejected the non-ASCII search terms, so matching degraded to a client-side scan of recent subjects and senders (message bodies were not searched). Narrow by sender or date for better recall.',
          )
        }
        if (sentMissing) {
          notes.push('No Sent folder was found on the server, so only INBOX was searched.')
        }
        return { hits: merged, ...(notes.length ? { note: notes.join(' ') } : {}) }
      })
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

      // Resolve threading headers from the replied-to message (RFC ids live
      // on the server, not in the model's input).
      let inReplyToHeader: string | undefined
      let references: string[] | undefined
      if (params.inReplyTo) {
        const ref = parseMessageRef(params.inReplyTo)
        if (!ref) {
          throw new Error(
            `Invalid inReplyTo "${params.inReplyTo}" — expected the folder:uid shape from imapSearchMessages.`,
          )
        }
        await sessions.withClient(opts.cacheKey, settings, async (client) => {
          const lock = await client.getMailboxLock(ref.folder)
          try {
            const msg = await client.fetchOne(
              String(ref.uid),
              { envelope: true, headers: ['references'] },
              { uid: true },
            )
            if (!msg) throw new Error(`Message ${params.inReplyTo} not found — cannot thread the reply.`)
            const targetId = msg.envelope?.messageId ?? null
            if (targetId) {
              inReplyToHeader = targetId
              references = [...parseReferencesHeader(msg.headers), targetId]
            }
          } finally {
            lock.release()
          }
        })
      }

      const composed = await composeMailboxMessage({
        from: settings.email,
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

      return { messageId: composed.messageId }
    },
  }
}
