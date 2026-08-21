/**
 * Mailbox (IMAP/SMTP) tools — search, read, and send from the user's own
 * corporate mailbox (any IMAP host; AliMail is a connect-time preset).
 *
 * Identity lane (docs/architecture/integrations/mailbox-imap.md → "Product
 * shape"): these tools act AS THE CONNECTED USER on the user's own company
 * mailbox — the third lane beside Gmail (the user's Google account) and
 * Assistant Email (the assistant's own address). No lane ever silently
 * substitutes for another.
 *
 * Core stays network-free: the injected `MailboxApi` seam is implemented by
 * the API layer (`packages/api/src/mailbox/`, imapflow + nodemailer). Core
 * owns the agentic-search policy (D12): full-history sender/subject lookup,
 * the 90-day broad-search window, result caps, snippet truncation, and
 * client-side thread stitching from `References`/`In-Reply-To` (never the
 * optional server THREAD extension).
 *
 * Attachment delivery (Phase 3, D15-D17): `imapGetMessage` lists parts with
 * their BODYSTRUCTURE ids, `imapSaveAttachment` lands one part's bytes in the
 * workspace file primitive, and the existing `sendFile` delivers it. Outbound
 * `imapSendMessage` attachments also resolve through that file primitive before
 * crossing the seam as MIME-ready bytes, keeping access/sensitivity gates in
 * core while the API layer owns SMTP composition.
 *
 * [COMP:tools/mailbox-imap]
 * [COMP:tools/imap-attachments]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import type { FilesApi } from '../../workspace-files/api.js'
import { MAX_EXTERNAL_DOCUMENT_BYTES } from '../../workspace-files/attachments.js'
import { ctxFor, errorMessage, idOrPathShape, workspaceGate } from '../../workspace-files/tool-helpers.js'
import { mailboxFailure } from './_mailbox-error.js'

/** Default lookback window for searches with no explicit `since` (D12 #4). */
export const MAILBOX_DEFAULT_WINDOW_DAYS = 90
/** Default / max result caps — an unindexed server-side scan can never flood a turn. */
export const MAILBOX_DEFAULT_LIMIT = 20
export const MAILBOX_MAX_LIMIT = 50
/** Snippets are truncated so a broad search stays token-bounded. */
export const MAILBOX_SNIPPET_CHARS = 200
/**
 * Max attachment size `imapSaveAttachment` will pull (D16). Deliberately
 * EQUAL to `MAX_EXTERNAL_DOCUMENT_BYTES`: a save that succeeds is always
 * deliverable by `sendFile` on a messaging channel, so the chain never
 * strands a stored file the user asked to be sent.
 */
export const MAILBOX_ATTACHMENT_MAX_BYTES = MAX_EXTERNAL_DOCUMENT_BYTES
/** SMTP attachment caps mirror Gmail's reviewed raw-byte envelope. */
export const MAX_MAILBOX_OUTGOING_ATTACHMENTS = 10
export const MAX_MAILBOX_OUTGOING_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024

/** Resolved outbound document crossing the core → SMTP seam. */
export type MailboxOutgoingAttachment = {
  filename: string
  mime: string
  data: Uint8Array
}

/** One search hit — already projected to documented fields by the seam impl. */
export type MailboxSearchHit = {
  /** Provider message id, `<folder>:<uid>` — pass to `imapGetMessage`. */
  id: string
  folder: string
  from: string
  to?: string[]
  /** ISO date, null when the envelope carried none. */
  date: string | null
  subject: string
  snippet?: string
  /** RFC 5322 Message-ID / threading refs, used for client-side stitching. */
  messageId?: string | null
  inReplyTo?: string | null
  references?: string[]
}

/**
 * One attachment as listed by `imapGetMessage`. Derived from the server's
 * BODYSTRUCTURE, which is the sole authority for part ids (D14) — a parse of
 * the (size-capped) message source numbers raw-stream boundaries, not the
 * IMAP part tree, and silently addresses the wrong part on nested multiparts.
 */
export type MailboxAttachment = {
  filename: string
  mime: string
  /**
   * Encoded size in octets, as the server reports it. Base64 inflates the
   * decoded bytes by ~33%, so this over-states the real file — which is what
   * a size gate wants.
   */
  size: number
  /**
   * IMAP part number (`"2"`, `"1.2"`, …) — the `partId` `imapSaveAttachment`
   * takes to fetch exactly this part.
   */
  partId: string
}

export type MailboxMessage = {
  id: string
  folder: string
  from: string
  to: string[]
  cc?: string[]
  date: string | null
  subject: string
  /** Text body: text/plain part preferred, stripped HTML fallback. */
  body: string
  /**
   * Attachment metadata + part ids. Bytes are fetched on request only
   * (D15) — one part at a time, via `imapSaveAttachment`; sync-time content
   * extraction remains out of scope (D10).
   */
  attachments: MailboxAttachment[]
  messageId?: string | null
  inReplyTo?: string | null
  references?: string[]
}

/** One attachment's decoded bytes — the `getAttachment` return (D14/D16). */
export type MailboxAttachmentBytes = {
  filename: string
  mime: string
  bytes: Uint8Array
}

export type MailboxSearchParams = {
  /** OR'd together server-side (one round trip — the seam compiles the OR tree). */
  keywords?: string[]
  from?: string
  subject?: string
  /**
   * Explicit folder override. Undefined = the implementation's default scope:
   * every selectable ordinary folder, including regular custom/nested folders.
   */
  folder?: string
  /** YYYY-MM-DD lower bound. Undefined means the full live mailbox history. */
  since?: string
  /**
   * Literal archive lower bound. `null` explicitly means full synced history;
   * undefined inherits `since` for direct seam callers.
   */
  archiveSince?: string | null
  before?: string
  /** Core always supplies (default 20, capped at 50). */
  limit: number
}

export type MailboxApi = {
  searchMessages(params: MailboxSearchParams): Promise<{
    hits: MailboxSearchHit[]
    /** Honest degradation note (e.g. server rejected UTF-8 search; client-side filter used). */
    note?: string
  }>
  getMessage(id: string): Promise<MailboxMessage>
  /**
   * Stream ONE attachment part's decoded bytes (D14). Implementations must
   * fetch the part directly — never the size-capped full-source fetch
   * `getMessage` uses — and must refuse over-cap parts from the
   * BODYSTRUCTURE metadata *before* streaming, then count bytes while
   * buffering so a lying/absent size cannot blow past
   * {@link MAILBOX_ATTACHMENT_MAX_BYTES}.
   */
  getAttachment(id: string, partId: string): Promise<MailboxAttachmentBytes>
  sendMessage(params: {
    to: string[]
    /** Visible carbon-copy recipients (a real `Cc:` header). */
    cc?: string[]
    /** Blind carbon-copy recipients: added to the SMTP envelope only, never a header. */
    bcc?: string[]
    subject: string
    /** Markdown source — the API layer renders it to multipart/alternative. */
    body: string
    /** Resolved workspace files — the API layer composes real MIME parts. */
    attachments?: MailboxOutgoingAttachment[]
    /** Provider id (`folder:uid`) of the message being replied to — sets In-Reply-To/References. */
    inReplyTo?: string
    /**
     * Explicit sender: the account address or one of its configured send-as
     * aliases (mailbox-imap.md → "Send-as aliases"). The API layer REFUSES any
     * other value with the allowed list; omitted, a reply resolves to the
     * alias the original was addressed to, else the account (D4).
     */
    from?: string
  }): Promise<{
    messageId: string | null
    /** The sender the message actually went out as (header From = envelope MAIL FROM, D5). */
    from?: string
  }>
  /**
   * Resolve the sender a `sendMessage` with these inputs WOULD use, without
   * sending — the confirmation preview and the approval card show the real
   * From (an alias picked from the replied-to envelope, or the account).
   * Throws the same allowlist refusal `sendMessage` would for an explicit
   * `from` outside the account + aliases. Optional: a seam that cannot
   * resolve (tests, a provider without aliases) leaves the tool showing the
   * bound account address.
   */
  resolveSender?(params: { from?: string; inReplyTo?: string }): Promise<{ from: string; allowed: string[] }>
}

/** A stitched conversation thread, newest thread first. */
export type MailboxThread = {
  subject: string
  lastDate: string | null
  messages: MailboxSearchHit[]
}

function normalizeSubject(subject: string): string {
  let s = subject.trim().toLowerCase()
  // Strip any run of reply/forward prefixes (Re:, Fwd:, Fw:, 回复:, 转发:).
  for (;;) {
    const next = s.replace(/^(re|fwd?|aw|回复|回覆|转发|轉發)\s*[:：]\s*/i, '')
    if (next === s) break
    s = next
  }
  return s
}

/**
 * Group hits into conversation threads client-side from
 * `References`/`In-Reply-To` (subject fallback), per D12 #5 — the server
 * THREAD extension is optional and never relied on. Threads sort newest
 * first; messages inside a thread sort oldest first.
 */
export function stitchMailboxThreads(hits: MailboxSearchHit[]): MailboxThread[] {
  // Union-find over message ids: a message joins the thread of anything it
  // references. Root key = the earliest known id in its reference chain.
  const keyOf = new Map<string, string>()
  const resolve = (k: string): string => {
    let cur = k
    while (keyOf.has(cur) && keyOf.get(cur) !== cur) cur = keyOf.get(cur)!
    return cur
  }
  const union = (a: string, b: string) => {
    const ra = resolve(a)
    const rb = resolve(b)
    if (ra !== rb) keyOf.set(rb, ra)
    if (!keyOf.has(ra)) keyOf.set(ra, ra)
  }

  const hitKey = (h: MailboxSearchHit): string => {
    const chain = [...(h.references ?? []), h.inReplyTo, h.messageId].filter(
      (x): x is string => Boolean(x),
    )
    if (chain.length === 0) return `subject:${normalizeSubject(h.subject)}`
    for (const id of chain) if (!keyOf.has(id)) keyOf.set(id, id)
    for (let i = 1; i < chain.length; i++) union(chain[0], chain[i])
    return resolve(chain[0])
  }

  const groups = new Map<string, MailboxSearchHit[]>()
  const keys = hits.map((h) => hitKey(h))
  // Second pass: keys may have been merged by later unions.
  for (let i = 0; i < hits.length; i++) {
    const k = keys[i].startsWith('subject:') ? keys[i] : resolve(keys[i])
    const arr = groups.get(k)
    if (arr) arr.push(hits[i])
    else groups.set(k, [hits[i]])
  }

  const time = (d: string | null | undefined) => (d ? Date.parse(d) || 0 : 0)
  const threads: MailboxThread[] = []
  for (const messages of groups.values()) {
    messages.sort((a, b) => time(a.date) - time(b.date))
    const last = messages[messages.length - 1]
    threads.push({
      subject: last.subject || messages[0].subject,
      lastDate: last.date ?? null,
      messages,
    })
  }
  threads.sort((a, b) => time(b.lastDate) - time(a.lastDate))
  return threads
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

const EMAIL_ADDRESS_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi

/**
 * Deterministically recover an exact sender address from the current request.
 * A single external address is safe to promote; zero or several addresses are
 * left to the model because guessing would narrow the search incorrectly.
 */
export function inferExactExternalEmail(params: {
  texts: Array<string | null | undefined>
  boundAccountEmail?: string
  explicitFrom?: string
}): string | undefined {
  if (params.explicitFrom?.trim()) return undefined
  const bound = params.boundAccountEmail?.trim().toLowerCase()
  const found = new Set<string>()
  for (const text of params.texts) {
    for (const match of text?.match(EMAIL_ADDRESS_RE) ?? []) {
      const email = match.toLowerCase()
      if (email !== bound) found.add(email)
    }
  }
  return found.size === 1 ? [...found][0] : undefined
}

function truncateSnippet(s: string | undefined): string | undefined {
  if (!s) return s
  return s.length > MAILBOX_SNIPPET_CHARS ? `${s.slice(0, MAILBOX_SNIPPET_CHARS)}…` : s
}


/** A connected company mailbox, primary (first-connected) first. */
export type MailboxAccountRef = {
  /** The mailbox email address — the router's authoritative identity key. */
  email: string
  /** True for the user's primary (first-connected) mailbox — the default sender. */
  isPrimary: boolean
}

/**
 * Mailbox router. It still supports the legacy multi-account `account`
 * selector for direct factory consumers, while runtime injection now builds a
 * one-account router per instance and hides that selector from the tool schema.
 */
export type MailboxAccountRouter = {
  /** Every connected mailbox for this user, primary first. */
  list(): MailboxAccountRef[]
  /** The `MailboxApi` for a mailbox email (case-insensitive), or undefined. */
  get(email: string): MailboxApi | undefined
}

/** Single-account router — the one-mailbox common case and tests. */
export function singleMailboxRouter(api: MailboxApi, email: string): MailboxAccountRouter {
  return {
    list: () => [{ email, isPrimary: true }],
    get: (e) => (e.trim().toLowerCase() === email.trim().toLowerCase() ? api : undefined),
  }
}

/**
 * Resolve the `account` argument to a concrete `MailboxApi` (mirrors
 * AgentMail's `resolveInbox`): an explicit account matches by email or fails
 * with an honest list of what IS connected; omitted resolves to the primary.
 */
function resolveMailboxAccount(
  router: MailboxAccountRouter,
  account: string | undefined,
): { ok: true; api: MailboxApi; email: string } | { ok: false; error: string } {
  const accounts = router.list()
  if (accounts.length === 0) {
    return { ok: false, error: 'No email account is connected through IMAP/SMTP. Connect one in Studio → Connectors, then try again.' }
  }
  const pick = (email: string): { ok: true; api: MailboxApi; email: string } | { ok: false; error: string } => {
    const api = router.get(email)
    return api ? { ok: true, api, email } : { ok: false, error: `Email account ${email} is unavailable right now.` }
  }
  if (account) {
    const wanted = account.trim().toLowerCase()
    const match = accounts.find((a) => a.email.trim().toLowerCase() === wanted)
    if (!match) {
      return {
        ok: false,
        error: `No connected email account "${account}". Connected email accounts: ${accounts.map((a) => a.email).join(', ')}.`,
      }
    }
    return pick(match.email)
  }
  return pick((accounts.find((a) => a.isPrimary) ?? accounts[0]).email)
}

/** The `account` field shared by every tool schema — omitted = primary mailbox. */
const accountField = z
  .string()
  .optional()
  .describe(
    'Which connected email account to use, by its email address. ' +
    'Omit to use the primary (first-connected) email account. Only needed when more than one email account is connected.',
  )

/**
 * Everything `imapSaveAttachment` needs beyond the mailbox seam. Absent =
 * the tool is not built at all (never a tool that always errors) — the
 * `gmailSendMessage` attachments conditioning.
 */
export type MailboxAttachmentDeps = {
  /** Workspace file primitive — the authority for inbound saves and outbound sends. */
  filesApi: FilesApi
  /**
   * Make the saved file searchable (the API layer's file-ingest queue).
   * Best-effort: a queue hiccup must not lose a file the user can already
   * be handed. Absent = saved but not indexed.
   */
  enqueueIngest?: (params: {
    fileId: string
    workspaceId: string
    actingUserId: string
    assistantId: string | null
  }) => Promise<void>
}

export type CreateMailboxToolsOptions = {
  attachments?: MailboxAttachmentDeps
  /**
   * Bind every generated tool to this mailbox and omit `account` from its
   * model-facing schema. Runtime injection sets this for every per-instance
   * canonical/variant tool set.
   */
  boundAccountEmail?: string
}

/** Filesystem-safe leaf name, mirroring the channel-media persist shape. */
function safeAttachmentName(filename: string): string {
  return filename.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'attachment'
}

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return formatMb(bytes)
}

export function createMailboxTools(
  router: MailboxAccountRouter,
  opts?: CreateMailboxToolsOptions,
): Tool[] {
  const attachmentDeps = opts?.attachments
  const boundAccountEmail = opts?.boundAccountEmail
  const accountInputShape: z.ZodRawShape = boundAccountEmail ? {} : { account: accountField }
  const resolveForInput = (input: unknown) => {
    const selected = boundAccountEmail ?? (
      typeof (input as { account?: unknown } | null)?.account === 'string'
        ? (input as { account: string }).account
        : undefined
    )
    return resolveMailboxAccount(router, selected)
  }
  const accountRoutingDescription = boundAccountEmail
    ? `This tool is bound to the email account ${boundAccountEmail}; use the separately named tool set for another email account.`
    : 'If more than one email account is connected, pass `account` (the email address) to choose which; omit it for the primary.'
  const searchMessages = buildTool({
    name: 'imapSearchMessages',
    description:
      "Search email in the user's connected email account. Use this to summarize email, check recent email, or find specific email regardless of provider. " +
      'The email account is connected through IMAP/SMTP, which is the connection method rather than the provider; it may be hosted by Gmail/Google Workspace, AliMail, or another provider. ' +
      "It is the user's exact bound address, never the assistant's own address. " +
      'Searches every selectable ordinary folder by default, including INBOX, Sent, Archive, and custom folders, so mail moved by a user or provider rule is still discoverable. Junk, Trash, Drafts, aggregate All Mail, and non-selectable containers are excluded; pass `folder` to search one folder only. ' +
      'Literal search combines the live mail server with the synced personal archive, so provider search quirks and missing embeddings cannot hide an exact sender, subject, or body match. Start with 2-4 `keywords` (they are OR\'d, so include synonyms), then refine by sender, subject, or date. ' +
      'Sender matches rank ahead of subject matches, then body matches; results come back grouped into conversation threads with snippets. ' +
      `Sender- or subject-constrained searches cover the full live history by default. Broad and keyword-only live search defaults to the last ${MAILBOX_DEFAULT_WINDOW_DAYS} days, while its literal archive arm covers all synced history. Pass \`since\` to bound both. ` +
      accountRoutingDescription,
    inputSchema: z.object({
      keywords: z
        .array(z.string())
        .max(8)
        .optional()
        .describe('Words or phrases matched against message text; any match counts (OR). Include synonyms — one call, one round trip.'),
      from: z.string().optional().describe('Only messages whose sender matches this substring (name or address).'),
      subject: z.string().optional().describe('Only messages whose subject contains this substring.'),
      folder: z
        .string()
        .optional()
        .describe('Search one specific folder instead of the default all-selectable-folders scope.'),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(`Earliest date (YYYY-MM-DD). Broad/keyword-only default: ${MAILBOX_DEFAULT_WINDOW_DAYS} days ago; sender/subject default: full history.`),
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Latest date (YYYY-MM-DD), exclusive.'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAILBOX_MAX_LIMIT)
        .optional()
        .describe(`Max messages to return (default ${MAILBOX_DEFAULT_LIMIT}, max ${MAILBOX_MAX_LIMIT}).`),
      ...accountInputShape,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 30_000,

    async execute(input, context) {
      const resolved = resolveForInput(input)
      if (!resolved.ok) return { data: resolved.error, isError: true }
      const api = resolved.api
      try {
        const limit = Math.min(input.maxResults ?? MAILBOX_DEFAULT_LIMIT, MAILBOX_MAX_LIMIT)
        const inferredFrom = inferExactExternalEmail({
          texts: [context.userMessageText, ...(input.keywords ?? [])],
          boundAccountEmail: resolved.email,
          explicitFrom: input.from,
        })
        const from = input.from ?? inferredFrom
        const keywords = inferredFrom
          ? input.keywords?.filter((term) => term.trim().toLowerCase() !== inferredFrom)
          : input.keywords
        const hasEnvelopeFilter = Boolean(from?.trim() || input.subject?.trim())
        const { hits, note } = await api.searchMessages({
          keywords: keywords?.length ? keywords : undefined,
          from,
          subject: input.subject,
          folder: input.folder,
          since: input.since ?? (hasEnvelopeFilter ? undefined : isoDaysAgo(MAILBOX_DEFAULT_WINDOW_DAYS)),
          archiveSince: input.since ?? null,
          before: input.before,
          limit,
        })
        const bounded = hits.slice(0, limit).map((h) => ({ ...h, snippet: truncateSnippet(h.snippet) }))
        const threads = stitchMailboxThreads(bounded).map((t) => ({
          subject: t.subject,
          lastDate: t.lastDate,
          messages: t.messages.map(({ messageId: _m, inReplyTo: _r, references: _refs, ...rest }) => rest),
        }))
        return { data: { threads, ...(note ? { note } : {}) } }
      } catch (err) {
        return mailboxFailure(err, { tool: 'imapSearchMessages', email: resolved.email, target: input.folder ? `folder \`${input.folder}\`` : undefined })
      }
    },
  })

  const getMessage = buildTool({
    name: 'imapGetMessage',
    description:
      "Read a full email from the user's connected email account by id (the `id` returned by imapSearchMessages, shaped `folder:uid`). " +
      'Returns headers, the text body, and the attachment list (filename, type, size, and the `partId` that identifies each part). ' +
      // Only claim the save path exists when it was actually wired — the
      // tool-awareness rule applied at the description level.
      (attachmentDeps
        ? 'To hand an attachment to the user, save it with imapSaveAttachment using its `partId`, then deliver it with sendFile.'
        : 'Attachment contents cannot be fetched here.') +
      ` ${accountRoutingDescription}`,
    inputSchema: z.object({
      messageId: z.string().describe('The message id from imapSearchMessages results (`folder:uid`).'),
      ...accountInputShape,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,

    async execute(input) {
      const resolved = resolveForInput(input)
      if (!resolved.ok) return { data: resolved.error, isError: true }
      try {
        const data = await resolved.api.getMessage(input.messageId)
        return { data }
      } catch (err) {
        return mailboxFailure(err, { tool: 'imapGetMessage', email: resolved.email, target: `message \`${input.messageId}\`` })
      }
    },
  })

  const sendMessage = buildTool({
    name: 'imapSendMessage',
    description:
      "Send email from the user's connected email account. Use this for ordinary email sending from the user's exact bound address, regardless of provider. " +
      'The email account is connected through IMAP/SMTP and may be hosted by Gmail/Google Workspace (including an address ending in gmail.com), AliMail, or another provider; the recipient sees the exact bound address as the sender. ' +
      'This is the ONLY tool that sends as that bound address: if it is unavailable, say so — never silently substitute another email identity for it (or it for them). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt. ' +
      'To reply on an existing thread, pass the original message\'s id as `inReplyTo` so the reply threads correctly. ' +
      'A reply goes out from the address the original was sent to when that is one of the account\'s configured send-as aliases (otherwise from the account itself); pass `from` only to pick a specific configured alias - any other address is refused. ' +
      'Copy additional people with `cc` (visible to every recipient) or `bcc` (hidden from the others); put an internal colleague you are looping in on `cc` unless the user asks to keep them hidden. ' +
      'Workspace files can be attached as real email attachments: pass their ids or absolute paths in `attachments`. ' +
      'Only brain-saved files can be attached; confidential files are refused. Limits: 10 attachments, 18 MB total. ' +
      'If attachment resolution fails, relay the reason honestly and never claim the document was attached. ' +
      accountRoutingDescription,
    inputSchema: z.object({
      to: z.array(z.string()).min(1).max(20).describe('Recipient email addresses.'),
      cc: z.array(z.string()).max(20).optional().describe('CC addresses: copied recipients, visible to everyone on the email.'),
      bcc: z.array(z.string()).max(20).optional().describe('BCC addresses: copied recipients hidden from everyone else on the email.'),
      subject: z.string().describe('Email subject line.'),
      body: z
        .string()
        .describe(
          'Email body. Markdown is supported and rendered into real email formatting before sending ' +
          '(headings, bold, lists, links, and tables become proper HTML, with a plain-text version ' +
          'generated automatically). Write it the way an email reads: greeting, short paragraphs, sign-off.',
        ),
      attachments: z
        .array(idOrPathShape)
        .max(MAX_MAILBOX_OUTGOING_ATTACHMENTS)
        .optional()
        .describe(
          'Workspace files to attach — each entry a file id or absolute workspace path. ' +
          'The recipient receives real MIME parts, not storage links.',
        ),
      inReplyTo: z
        .string()
        .optional()
        .describe('Message id (`folder:uid`) of the message being replied to — threads the reply via In-Reply-To/References.'),
      from: z
        .string()
        .optional()
        .describe(
          'Sender address: one of this account\'s configured send-as aliases (or the account itself). ' +
          'Omit to reply from the address the original was sent to (falls back to the account). Any other address is refused.',
        ),
      ...accountInputShape,
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async describeConfirmation(input, context) {
      const draft = (input ?? {}) as {
        account?: unknown
        to?: unknown
        cc?: unknown
        bcc?: unknown
        subject?: unknown
        body?: unknown
        attachments?: unknown
        inReplyTo?: unknown
        from?: unknown
      }
      const resolved = resolveForInput(draft)
      if (!resolved.ok) return null
      const recipients = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
      const to = recipients(draft.to)
      const cc = recipients(draft.cc)
      const bcc = recipients(draft.bcc)
      // The From line shows the sender the send WOULD use — an alias picked from
      // the replied-to envelope, an explicit alias, or the account — so the
      // approver consents to the identity, not just the recipients. An
      // explicit `from` outside the allowlist is called out here and refused
      // at execute; a seam without `resolveSender` shows the account.
      let fromLine = `• From: ${resolved.email}`
      const explicitFrom = typeof draft.from === 'string' && draft.from.trim() ? draft.from.trim() : undefined
      const replyTo = typeof draft.inReplyTo === 'string' && draft.inReplyTo.trim() ? draft.inReplyTo.trim() : undefined
      if (resolved.api.resolveSender && (explicitFrom || replyTo)) {
        try {
          const sender = await resolved.api.resolveSender({
            ...(explicitFrom ? { from: explicitFrom } : {}),
            ...(replyTo ? { inReplyTo: replyTo } : {}),
          })
          fromLine = `• From: ${sender.from}`
        } catch (err) {
          fromLine = explicitFrom
            ? `• From: ${explicitFrom} (not an allowed sender: send will be refused - ${err instanceof Error ? err.message : String(err)})`
            : `• From: ${resolved.email}`
        }
      } else if (explicitFrom) {
        fromLine = `• From: ${explicitFrom}`
      }
      const lines = [
        fromLine,
        ...(to.length > 0 ? [`• To: ${to.join(', ')}`] : []),
      ]
      if (cc.length > 0) lines.push(`• Cc: ${cc.join(', ')}`)
      if (bcc.length > 0) lines.push(`• Bcc: ${bcc.join(', ')}`)
      if (typeof draft.subject === 'string') lines.push(`• Subject: ${draft.subject}`)
      if (typeof draft.body === 'string') lines.push(`• Body: ${draft.body}`)
      const refs = Array.isArray(draft.attachments)
        ? draft.attachments.filter((v): v is string => typeof v === 'string')
        : []
      if (refs.length > 0) {
        if (!attachmentDeps || !context.workspaceId) {
          for (const ref of refs) lines.push(`• Attachment: ${ref}`)
          return lines
        }
        const seen = new Set<string>()
        const ctx = ctxFor(context)
        for (const ref of refs) {
          const stat = await attachmentDeps.filesApi.stat(ctx, ref)
          if (!stat.ok) {
            lines.push(`• Attachment: ${ref} (not found)`)
            continue
          }
          const file = stat.value
          if (seen.has(file.id)) continue
          seen.add(file.id)
          lines.push(
            file.sensitivity === 'confidential'
              ? `• Attachment: ${file.name} (confidential: send will be refused)`
              : `• Attachment: ${file.name} (${formatSize(file.sizeBytes)})`,
          )
        }
      }
      return lines
    },

    async execute(input, context) {
      const resolved = resolveForInput(input)
      if (!resolved.ok) return { data: resolved.error, isError: true }
      try {
        // Egress-safety gate (the gmailSendMessage / agentmail precedent):
        // if confidential content entered the model's context this turn, the
        // free-text body could carry it out of the workspace — refuse.
        if (context.sensitivity?.max === 'confidential') {
          return {
            data:
              'This turn is handling confidential workspace content, so the email cannot be sent — ' +
              'recipients are outside the workspace and the message body could carry it. Share confidential ' +
              'material from the web app instead, or compose the email in a separate turn that does not read ' +
              'confidential data.',
            isError: true,
          }
        }
        let attachments: MailboxOutgoingAttachment[] | undefined
        if (input.attachments && input.attachments.length > 0) {
          if (!attachmentDeps) {
            return {
              data:
                'File attachments are not available in this context — workspace file storage is not wired here. ' +
                'Send the email without attachments, or tell the user to share the file another way.',
              isError: true,
            }
          }
          const gate = workspaceGate(context.workspaceId)
          if (gate) return gate
          const ctx = ctxFor(context)

          // Resolve every metadata row and run all gates before reading bytes.
          const seen = new Set<string>()
          const files: Array<{ id: string; path: string; name: string; mime: string; sizeBytes: number }> = []
          for (const ref of input.attachments) {
            const stat = await attachmentDeps.filesApi.stat(ctx, ref)
            if (!stat.ok) return { data: errorMessage(stat.error), isError: true }
            const file = stat.value
            if (seen.has(file.id)) continue
            seen.add(file.id)
            if (file.sensitivity === 'confidential') {
              return {
                data:
                  `${file.path} is confidential and cannot be emailed — email recipients are outside the workspace. ` +
                  'Tell the user to share it from the web app instead.',
                isError: true,
              }
            }
            files.push({
              id: file.id,
              path: file.path,
              name: file.name,
              mime: file.mime,
              sizeBytes: file.sizeBytes,
            })
          }

          const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
          if (totalBytes > MAX_MAILBOX_OUTGOING_ATTACHMENT_TOTAL_BYTES) {
            return {
              data:
                `Attachments total ${formatMb(totalBytes)} — over the ${formatMb(MAX_MAILBOX_OUTGOING_ATTACHMENT_TOTAL_BYTES)} email limit. ` +
                'Send fewer or smaller files, or tell the user to share the large ones from the web app.',
              isError: true,
            }
          }

          attachments = []
          for (const file of files) {
            const read = await attachmentDeps.filesApi.readBytes(ctx, file.id)
            if (!read.ok) return { data: errorMessage(read.error), isError: true }
            attachments.push({ filename: file.name, mime: file.mime, data: read.value.bytes })
          }
        }

        const data = await resolved.api.sendMessage({
          to: input.to,
          ...(input.cc?.length ? { cc: input.cc } : {}),
          ...(input.bcc?.length ? { bcc: input.bcc } : {}),
          subject: input.subject,
          body: input.body,
          ...(attachments?.length ? { attachments } : {}),
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
          ...(input.from?.trim() ? { from: input.from.trim() } : {}),
        })
        return {
          data: {
            messageId: data.messageId,
            // The identity the mail actually carried: an alias when the seam
            // resolved one (reply-from-origin / explicit), else the account.
            from: data.from ?? resolved.email,
            ...(attachments?.length ? { attached: attachments.map((file) => file.filename) } : {}),
          },
        }
      } catch (err) {
        return mailboxFailure(err, { tool: 'imapSendMessage', email: resolved.email, target: `the message to ${input.to.join(', ')}`, send: true })
      }
    },
  })

  // ── imapSaveAttachment (Phase 3, D15-D17) ───────────────────────────────
  //
  // Built ONLY when the workspace-file primitive is wired: the whole point is
  // to land bytes in the file layer so `sendFile` can deliver them, and a
  // tool that always answers "storage is not available here" is worse than an
  // absent one (the `gmailSendMessage` attachments conditioning).
  //
  // Read/allow like `syncMailboxNow` — it writes only inside the workspace,
  // outbound delivery stays gated by `sendFile`. On-request only (D15): the
  // sync worker never calls this, and nothing auto-mirrors a mailbox.
  const saveAttachment = attachmentDeps
    ? buildTool({
        name: 'imapSaveAttachment',
        requiresCapability: 'files',
        description:
          "Save one attachment from an email in the user's connected email account into the workspace as a real file, then attach it to your reply with sendFile. " +
          'Use this when the user asks for a document that arrived by email (a boarding pass, invoice, statement, contract) — read the message with imapGetMessage first, take the `partId` of the attachment you want from its attachment list, save it here, then pass the returned `fileId` to sendFile. ' +
          `One attachment per call, up to ${formatMb(MAILBOX_ATTACHMENT_MAX_BYTES)}. ` +
          accountRoutingDescription,
        inputSchema: z.object({
          messageId: z.string().describe('The message id from imapSearchMessages or imapGetMessage (`folder:uid`).'),
          partId: z
            .string()
            .describe('The `partId` of the attachment, taken from imapGetMessage\'s attachment list (e.g. "2" or "1.2").'),
          title: z
            .string()
            .min(1)
            .max(256)
            .optional()
            .describe('Display label for the saved file. Defaults to the attachment filename.'),
          ...accountInputShape,
        }),
        isConcurrencySafe: false,
        isReadOnly: false,
        requiresConfirmation: false,
        // A multi-MB part over a residential link does not fit imapGetMessage's 20s.
        timeoutMs: 60_000,

        async execute(input, context) {
          const gate = workspaceGate(context.workspaceId)
          if (gate) return gate
          const resolved = resolveForInput(input)
          if (!resolved.ok) return { data: resolved.error, isError: true }
          try {
            // Both size gates (BODYSTRUCTURE pre-check + streamed byte count)
            // live in the seam — only it can see the part metadata.
            const attachment = await resolved.api.getAttachment(input.messageId, input.partId)
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const safeName = safeAttachmentName(attachment.filename)
            const stored = await attachmentDeps.filesApi.writeBytes(ctxFor(context), {
              path: `/uploads/email/${stamp}-${safeName}`,
              bytes: attachment.bytes,
              mime: attachment.mime,
              title: input.title ?? attachment.filename,
              // Flat `internal` (D16) — no instance-level sensitivity exists
              // on a mailbox to inherit from.
              sensitivity: 'internal',
            })
            if (!stored.ok) return { data: errorMessage(stored.error), isError: true }
            const file = stored.value
            if (attachmentDeps.enqueueIngest) {
              try {
                await attachmentDeps.enqueueIngest({
                  fileId: file.id,
                  workspaceId: context.workspaceId!,
                  actingUserId: context.userId,
                  assistantId: context.assistantId ?? null,
                })
              } catch (err) {
                console.warn(
                  '[mailbox] attachment saved but ingest enqueue failed (best-effort):',
                  err instanceof Error ? err.message : String(err),
                )
              }
            }
            return {
              data: {
                fileId: file.id,
                path: file.path,
                filename: attachment.filename,
                sizeBytes: file.sizeBytes,
              },
            }
          } catch (err) {
            return mailboxFailure(err, { tool: 'imapSaveAttachment', email: resolved.email, target: `attachment part \`${input.partId}\` of message \`${input.messageId}\`` })
          }
        },
      })
    : null

  return saveAttachment
    ? [searchMessages, getMessage, sendMessage, saveAttachment]
    : [searchMessages, getMessage, sendMessage]
}
