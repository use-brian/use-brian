/**
 * AgentMail REST client — thin fetch wrappers, Zod-validated responses.
 *
 * This file (plus provider.ts / webhook-verify.ts) is the ONLY place that
 * talks to AgentMail (decision D7 in docs/plans/agentmail-integration.md §7):
 * every feature layer consumes the EmailInboxProvider seam in ./provider.ts,
 * never this client directly.
 *
 * Auth: one Bearer key per client instance. Hosted passes the platform org
 * key; OSS passes the self-hoster's BYO key; per-inbox keys (when stored on
 * the integration row) construct a narrower client the same way.
 *
 * See docs/architecture/integrations/agentmail.md.
 * Component tag: [COMP:api/agentmail-client]
 */

import { z } from 'zod'

const AGENTMAIL_API_BASE = 'https://api.agentmail.to/v0'

// ── Response schemas ─────────────────────────────────────────
// Validate only the fields we consume; passthrough keeps forward-compat.

export const AgentmailInboxSchema = z
  .object({
    inbox_id: z.string(),
    email: z.string().optional(),
    display_name: z.string().nullish(),
    client_id: z.string().nullish(),
  })
  .passthrough()
export type AgentmailInbox = z.infer<typeof AgentmailInboxSchema>

export const AgentmailSendResultSchema = z
  .object({
    message_id: z.string(),
    thread_id: z.string(),
  })
  .passthrough()
export type AgentmailSendResult = z.infer<typeof AgentmailSendResultSchema>

export const AgentmailAttachmentMetaSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string().nullish(),
    size: z.number().nullish(),
    content_type: z.string().nullish(),
    content_disposition: z.string().nullish(),
    content_id: z.string().nullish(),
  })
  .passthrough()
export type AgentmailAttachmentMeta = z.infer<typeof AgentmailAttachmentMetaSchema>

export const AgentmailMessageSchema = z
  .object({
    inbox_id: z.string(),
    thread_id: z.string(),
    message_id: z.string(),
    labels: z.array(z.string()).default([]),
    timestamp: z.string(),
    from: z.string(),
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).nullish(),
    bcc: z.array(z.string()).nullish(),
    reply_to: z.array(z.string()).nullish(),
    subject: z.string().nullish(),
    preview: z.string().nullish(),
    text: z.string().nullish(),
    html: z.string().nullish(),
    /** Talon reply-extraction: body with quoted history stripped. */
    extracted_text: z.string().nullish(),
    attachments: z.array(AgentmailAttachmentMetaSchema).nullish(),
    in_reply_to: z.string().nullish(),
    references: z.array(z.string()).nullish(),
  })
  .passthrough()
export type AgentmailMessage = z.infer<typeof AgentmailMessageSchema>

export const AgentmailAttachmentDownloadSchema = z
  .object({
    attachment_id: z.string().optional(),
    filename: z.string().nullish(),
    size: z.number().nullish(),
    content_type: z.string().nullish(),
    download_url: z.string(),
    expires_at: z.string().nullish(),
  })
  .passthrough()
export type AgentmailAttachmentDownload = z.infer<typeof AgentmailAttachmentDownloadSchema>

export const AgentmailThreadItemSchema = z
  .object({
    inbox_id: z.string(),
    thread_id: z.string(),
    labels: z.array(z.string()).default([]),
    timestamp: z.string().nullish(),
    senders: z.array(z.string()).nullish(),
    recipients: z.array(z.string()).nullish(),
    subject: z.string().nullish(),
    preview: z.string().nullish(),
    last_message_id: z.string().nullish(),
    message_count: z.number().nullish(),
  })
  .passthrough()
export type AgentmailThreadItem = z.infer<typeof AgentmailThreadItemSchema>

export const AgentmailThreadListSchema = z
  .object({
    count: z.number().nullish(),
    next_page_token: z.string().nullish(),
    threads: z.array(AgentmailThreadItemSchema).default([]),
  })
  .passthrough()
export type AgentmailThreadList = z.infer<typeof AgentmailThreadListSchema>

export const AgentmailDraftSchema = z
  .object({
    inbox_id: z.string(),
    draft_id: z.string(),
    client_id: z.string().nullish(),
    to: z.array(z.string()).nullish(),
    cc: z.array(z.string()).nullish(),
    bcc: z.array(z.string()).nullish(),
    subject: z.string().nullish(),
    text: z.string().nullish(),
    html: z.string().nullish(),
    in_reply_to: z.string().nullish(),
    send_status: z.string().nullish(),
    send_at: z.string().nullish(),
  })
  .passthrough()
export type AgentmailDraft = z.infer<typeof AgentmailDraftSchema>

export const AgentmailDomainRecordSchema = z
  .object({
    type: z.string(),
    name: z.string(),
    value: z.string(),
    status: z.string().nullish(),
    priority: z.number().nullish(),
  })
  .passthrough()
export type AgentmailDomainRecord = z.infer<typeof AgentmailDomainRecordSchema>

export const AgentmailDomainSchema = z
  .object({
    domain_id: z.string(),
    domain: z.string(),
    /** NOT_STARTED | PENDING | INVALID | FAILED | VERIFYING | VERIFIED */
    status: z.string(),
    records: z.array(AgentmailDomainRecordSchema).default([]),
    feedback_enabled: z.boolean().nullish(),
    subdomains_enabled: z.boolean().nullish(),
  })
  .passthrough()
export type AgentmailDomain = z.infer<typeof AgentmailDomainSchema>

export const AgentmailWebhookSchema = z
  .object({
    webhook_id: z.string(),
    url: z.string(),
    event_types: z.array(z.string()).default([]),
    secret: z.string(),
    enabled: z.boolean().nullish(),
    client_id: z.string().nullish(),
  })
  .passthrough()
export type AgentmailWebhook = z.infer<typeof AgentmailWebhookSchema>

// ── Request shapes ───────────────────────────────────────────

export type AgentmailSendAttachment = {
  filename?: string
  content_type?: string
  /** Base64-encoded bytes. */
  content?: string
  /** Alternative to content: a URL AgentMail fetches. */
  url?: string
  content_disposition?: 'inline' | 'attachment'
  content_id?: string
}

export type AgentmailSendParams = {
  to?: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject?: string
  text?: string
  html?: string
  reply_to?: string | string[]
  labels?: string[]
  attachments?: AgentmailSendAttachment[]
}

export type AgentmailReplyParams = Omit<AgentmailSendParams, 'subject'> & {
  reply_all?: boolean
}

export type AgentmailCreateDraftParams = {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  text?: string
  html?: string
  attachments?: AgentmailSendAttachment[]
  /** Message id this draft replies to — vendor derives threading headers. */
  in_reply_to?: string
  reply_all?: boolean
  /** ISO 8601 scheduled send. */
  send_at?: string
  client_id?: string
}

// ── Errors ───────────────────────────────────────────────────

export class AgentmailApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'AgentmailApiError'
  }
}

// ── Client ───────────────────────────────────────────────────

export type AgentmailClient = {
  // Inboxes
  createInbox(params: {
    username?: string
    domain?: string
    display_name?: string
    client_id?: string
    metadata?: Record<string, string>
  }): Promise<AgentmailInbox>
  getInbox(inboxId: string): Promise<AgentmailInbox | null>
  deleteInbox(inboxId: string): Promise<void>
  // Messages
  sendMessage(inboxId: string, params: AgentmailSendParams): Promise<AgentmailSendResult>
  replyToMessage(inboxId: string, messageId: string, params: AgentmailReplyParams): Promise<AgentmailSendResult>
  getMessage(inboxId: string, messageId: string): Promise<AgentmailMessage | null>
  getAttachment(inboxId: string, messageId: string, attachmentId: string): Promise<AgentmailAttachmentDownload | null>
  // Threads
  listThreads(
    inboxId: string,
    params?: { limit?: number; page_token?: string; senders?: string[]; recipients?: string[]; subject?: string[] },
  ): Promise<AgentmailThreadList>
  // Drafts
  createDraft(inboxId: string, params: AgentmailCreateDraftParams): Promise<AgentmailDraft>
  sendDraft(inboxId: string, draftId: string): Promise<AgentmailSendResult>
  deleteDraft(inboxId: string, draftId: string): Promise<void>
  // Domains
  createDomain(params: { domain: string; feedback_enabled?: boolean; subdomains_enabled?: boolean }): Promise<AgentmailDomain>
  getDomain(domainId: string): Promise<AgentmailDomain | null>
  verifyDomain(domainId: string): Promise<AgentmailDomain>
  deleteDomain(domainId: string): Promise<void>
  // Webhooks
  createWebhook(inboxId: string, params: { url: string; event_types: string[]; client_id?: string }): Promise<AgentmailWebhook>
  deleteWebhook(inboxId: string, webhookId: string): Promise<void>
}

/** Injectable for tests; defaults to global fetch. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export function createAgentmailClient(params: { apiKey: string; fetchImpl?: FetchLike }): AgentmailClient {
  const doFetch: FetchLike = params.fetchImpl ?? ((url, init) => fetch(url, init))

  async function call<S extends z.ZodTypeAny>(
    schema: S,
    method: string,
    path: string,
    body?: unknown,
    opts?: { nullOn404?: boolean; query?: Record<string, string | string[] | number | undefined> },
  ): Promise<z.output<S> | null> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts?.query ?? {})) {
      if (v === undefined) continue
      if (Array.isArray(v)) for (const item of v) qs.append(k, item)
      else qs.set(k, String(v))
    }
    const suffix = qs.size > 0 ? `?${qs.toString()}` : ''
    const res = await doFetch(`${AGENTMAIL_API_BASE}${path}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

    if (res.status === 404 && opts?.nullOn404) return null
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.warn(`[agentmail] ${method} ${path} → ${res.status}: ${errBody.slice(0, 200)}`)
      if (res.status === 401 || res.status === 403) {
        throw new AgentmailApiError(
          'AgentMail rejected the API key. Check the configured key (or reconnect the inbox).',
          res.status,
        )
      }
      throw new AgentmailApiError(`AgentMail API error (${res.status}): ${errBody.slice(0, 300)}`, res.status)
    }

    // DELETE endpoints return no meaningful body.
    if (res.status === 204) return schema.parse({}) as z.output<S>
    const json = (await res.json().catch(() => ({}))) as unknown
    return schema.parse(json)
  }

  const enc = encodeURIComponent
  const EmptySchema = z.object({}).passthrough()

  return {
    async createInbox(p) {
      return (await call(AgentmailInboxSchema, 'POST', '/inboxes', p)) as AgentmailInbox
    },
    async getInbox(inboxId) {
      return call(AgentmailInboxSchema, 'GET', `/inboxes/${enc(inboxId)}`, undefined, { nullOn404: true })
    },
    async deleteInbox(inboxId) {
      await call(EmptySchema, 'DELETE', `/inboxes/${enc(inboxId)}`)
    },

    async sendMessage(inboxId, p) {
      return (await call(AgentmailSendResultSchema, 'POST', `/inboxes/${enc(inboxId)}/messages/send`, p)) as AgentmailSendResult
    },
    async replyToMessage(inboxId, messageId, p) {
      return (await call(
        AgentmailSendResultSchema,
        'POST',
        `/inboxes/${enc(inboxId)}/messages/${enc(messageId)}/reply`,
        p,
      )) as AgentmailSendResult
    },
    async getMessage(inboxId, messageId) {
      return call(AgentmailMessageSchema, 'GET', `/inboxes/${enc(inboxId)}/messages/${enc(messageId)}`, undefined, {
        nullOn404: true,
      })
    },
    async getAttachment(inboxId, messageId, attachmentId) {
      return call(
        AgentmailAttachmentDownloadSchema,
        'GET',
        `/inboxes/${enc(inboxId)}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`,
        undefined,
        { nullOn404: true },
      )
    },

    async listThreads(inboxId, p) {
      return (await call(AgentmailThreadListSchema, 'GET', `/inboxes/${enc(inboxId)}/threads`, undefined, {
        query: {
          limit: p?.limit,
          page_token: p?.page_token,
          senders: p?.senders,
          recipients: p?.recipients,
          subject: p?.subject,
        },
      })) as AgentmailThreadList
    },

    async createDraft(inboxId, p) {
      return (await call(AgentmailDraftSchema, 'POST', `/inboxes/${enc(inboxId)}/drafts`, p)) as AgentmailDraft
    },
    async sendDraft(inboxId, draftId) {
      return (await call(
        AgentmailSendResultSchema,
        'POST',
        `/inboxes/${enc(inboxId)}/drafts/${enc(draftId)}/send`,
        {},
      )) as AgentmailSendResult
    },
    async deleteDraft(inboxId, draftId) {
      await call(EmptySchema, 'DELETE', `/inboxes/${enc(inboxId)}/drafts/${enc(draftId)}`)
    },

    async createDomain(p) {
      return (await call(AgentmailDomainSchema, 'POST', '/domains', p)) as AgentmailDomain
    },
    async getDomain(domainId) {
      return call(AgentmailDomainSchema, 'GET', `/domains/${enc(domainId)}`, undefined, { nullOn404: true })
    },
    async verifyDomain(domainId) {
      return (await call(AgentmailDomainSchema, 'POST', `/domains/${enc(domainId)}/verify`, {})) as AgentmailDomain
    },
    async deleteDomain(domainId) {
      await call(EmptySchema, 'DELETE', `/domains/${enc(domainId)}`)
    },

    async createWebhook(inboxId, p) {
      return (await call(AgentmailWebhookSchema, 'POST', `/inboxes/${enc(inboxId)}/webhooks`, p)) as AgentmailWebhook
    },
    async deleteWebhook(inboxId, webhookId) {
      await call(EmptySchema, 'DELETE', `/inboxes/${enc(inboxId)}/webhooks/${enc(webhookId)}`)
    },
  }
}
