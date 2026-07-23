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
 * owns the agentic-search policy (D12): the 90-day default window, the
 * result cap, snippet truncation, and client-side thread stitching from
 * `References`/`In-Reply-To` (never the optional server THREAD extension).
 *
 * [COMP:tools/mailbox-imap]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'

/** Default lookback window for searches with no explicit `since` (D12 #4). */
export const MAILBOX_DEFAULT_WINDOW_DAYS = 90
/** Default / max result caps — an unindexed server-side scan can never flood a turn. */
export const MAILBOX_DEFAULT_LIMIT = 20
export const MAILBOX_MAX_LIMIT = 50
/** Snippets are truncated so a broad search stays token-bounded. */
export const MAILBOX_SNIPPET_CHARS = 200

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
  /** Attachment METADATA only — content extraction is out of scope (D10). */
  attachments: Array<{ filename: string; mime: string; size: number }>
  messageId?: string | null
  inReplyTo?: string | null
  references?: string[]
}

export type MailboxSearchParams = {
  /** OR'd together server-side (one round trip — the seam compiles the OR tree). */
  keywords?: string[]
  from?: string
  subject?: string
  /**
   * Explicit folder override. Undefined = the implementation's default scope:
   * INBOX plus the server's Sent folder (resolved via SPECIAL-USE `\Sent`).
   */
  folder?: string
  /** YYYY-MM-DD lower bound — core always supplies one (default window). */
  since: string
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
  sendMessage(params: {
    to: string
    subject: string
    /** Markdown source — the API layer renders it to multipart/alternative. */
    body: string
    /** Provider id (`folder:uid`) of the message being replied to — sets In-Reply-To/References. */
    inReplyTo?: string
  }): Promise<{ messageId: string | null }>
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

function truncateSnippet(s: string | undefined): string | undefined {
  if (!s) return s
  return s.length > MAILBOX_SNIPPET_CHARS ? `${s.slice(0, MAILBOX_SNIPPET_CHARS)}…` : s
}

function mailboxError(err: unknown): { data: string; isError: true } {
  return { data: `Mailbox error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
}

/** A connected company mailbox, primary (first-connected) first. */
export type MailboxAccountRef = {
  /** The mailbox email address — the value the model passes as `account`. */
  email: string
  /** True for the user's primary (first-connected) mailbox — the default sender. */
  isPrimary: boolean
}

/**
 * Multi-account router (D11 retired — the AgentMail `fromInbox` precedent):
 * the tools stay ONE set, an optional `account` picks one of the user's
 * connected mailboxes, and an omitted `account` resolves to the primary
 * (first-connected). The injector builds this over one per-instance
 * `MailboxApi` each; `list()` and `get()` are cheap (creds lazy-load on the
 * first real IMAP call).
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
    return { ok: false, error: 'No company mailbox is connected. Connect one in Studio → Connectors, then try again.' }
  }
  const pick = (email: string): { ok: true; api: MailboxApi; email: string } | { ok: false; error: string } => {
    const api = router.get(email)
    return api ? { ok: true, api, email } : { ok: false, error: `Company mailbox ${email} is unavailable right now.` }
  }
  if (account) {
    const wanted = account.trim().toLowerCase()
    const match = accounts.find((a) => a.email.trim().toLowerCase() === wanted)
    if (!match) {
      return {
        ok: false,
        error: `No connected company mailbox "${account}". Connected mailboxes: ${accounts.map((a) => a.email).join(', ')}.`,
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
    'Which connected company mailbox to use, by its email address. ' +
    'Omit to use the primary (first-connected) mailbox. Only needed when more than one mailbox is connected.',
  )

export function createMailboxTools(router: MailboxAccountRouter): Tool[] {
  const searchMessages = buildTool({
    name: 'imapSearchMessages',
    description:
      "Search the user's own company mailbox (their connected IMAP account — corporate email, not Gmail and not the assistant's address). " +
      'Searches INBOX and Sent by default, so "what did I reply to X" is answerable; pass `folder` to search elsewhere. ' +
      'Server-side search is substring matching with no ranking — iterate like grep: start with 2-4 `keywords` (they are OR\'d in one round trip, so include synonyms), ' +
      'then refine by sender, subject, or date. Results come back grouped into conversation threads with snippets. ' +
      `Defaults to the last ${MAILBOX_DEFAULT_WINDOW_DAYS} days — pass \`since\` to search older mail. ` +
      'If more than one company mailbox is connected, pass `account` (the mailbox email) to choose which; omit it for the primary.',
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
        .describe('Search a specific folder instead of the default INBOX + Sent scope.'),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(`Earliest date (YYYY-MM-DD). Default: ${MAILBOX_DEFAULT_WINDOW_DAYS} days ago.`),
      before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Latest date (YYYY-MM-DD), exclusive.'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(MAILBOX_MAX_LIMIT)
        .optional()
        .describe(`Max messages to return (default ${MAILBOX_DEFAULT_LIMIT}, max ${MAILBOX_MAX_LIMIT}).`),
      account: accountField,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 30_000,

    async execute(input) {
      const resolved = resolveMailboxAccount(router, input.account)
      if (!resolved.ok) return { data: resolved.error, isError: true }
      const api = resolved.api
      try {
        const limit = Math.min(input.maxResults ?? MAILBOX_DEFAULT_LIMIT, MAILBOX_MAX_LIMIT)
        const { hits, note } = await api.searchMessages({
          keywords: input.keywords,
          from: input.from,
          subject: input.subject,
          folder: input.folder,
          since: input.since ?? isoDaysAgo(MAILBOX_DEFAULT_WINDOW_DAYS),
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
        return mailboxError(err)
      }
    },
  })

  const getMessage = buildTool({
    name: 'imapGetMessage',
    description:
      "Read a full email from the user's connected company mailbox by id (the `id` returned by imapSearchMessages, shaped `folder:uid`). " +
      'Returns headers, the text body, and attachment names/sizes (attachment contents cannot be fetched).',
    inputSchema: z.object({
      messageId: z.string().describe('The message id from imapSearchMessages results (`folder:uid`).'),
      account: accountField,
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,

    async execute(input) {
      const resolved = resolveMailboxAccount(router, input.account)
      if (!resolved.ok) return { data: resolved.error, isError: true }
      try {
        const data = await resolved.api.getMessage(input.messageId)
        return { data }
      } catch (err) {
        return mailboxError(err)
      }
    },
  })

  const sendMessage = buildTool({
    name: 'imapSendMessage',
    description:
      "Send an email from the user's own company mailbox (their connected IMAP/SMTP account) — the recipient sees the user's corporate address as the sender. " +
      'This is the ONLY tool that sends as the corporate address: if it is unavailable, say so — never silently substitute another email identity for it (or it for them). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt. ' +
      'To reply on an existing thread, pass the original message\'s id as `inReplyTo` so the reply threads correctly. ' +
      'If more than one company mailbox is connected, pass `account` (the mailbox email) to choose which address to send AS; omit it for the primary.',
    inputSchema: z.object({
      to: z.string().describe('Recipient email address.'),
      subject: z.string().describe('Email subject line.'),
      body: z
        .string()
        .describe(
          'Email body. Markdown is supported and rendered into real email formatting before sending ' +
          '(headings, bold, lists, links, and tables become proper HTML, with a plain-text version ' +
          'generated automatically). Write it the way an email reads: greeting, short paragraphs, sign-off.',
        ),
      inReplyTo: z
        .string()
        .optional()
        .describe('Message id (`folder:uid`) of the message being replied to — threads the reply via In-Reply-To/References.'),
      account: accountField,
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async execute(input, context) {
      const resolved = resolveMailboxAccount(router, input.account)
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
        const data = await resolved.api.sendMessage({
          to: input.to,
          subject: input.subject,
          body: input.body,
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        })
        return { data: { messageId: data.messageId, from: resolved.email } }
      } catch (err) {
        return mailboxError(err)
      }
    },
  })

  return [searchMessages, getMessage, sendMessage]
}
