/**
 * Email inbox provider seam — the vendor-neutral interface every email
 * feature layer consumes (decision D7, docs/plans/agentmail-integration.md §7).
 *
 * The channel adapter, webhook route, provisioning routes, ingest producer,
 * connector tools, and UI routes all program against EmailInboxProvider;
 * AgentMail is the first implementation. Replacing the vendor (e.g. with an
 * SES-class DIY provider at scale) is a new implementation behind this
 * interface — no feature-layer change. Same pattern as the pages
 * custom-domains DomainProvisioner (../domains/provisioner.ts).
 *
 * Factory: createEmailInboxProvider(env) returns null when no API key is
 * configured — the whole email surface is then dark (provisioning routes
 * 503, webhook not mounted, UI hides the section). Mirrors the EmailAuth
 * boot pattern (SMTP mounts only when its env is set).
 *
 * See docs/architecture/integrations/agentmail.md.
 * Component tag: [COMP:api/agentmail-provider]
 */

import {
  createAgentmailClient,
  type AgentmailClient,
  type AgentmailSendAttachment,
} from './client.js'
import { verifySvixSignature, type SvixHeaders } from './webhook-verify.js'

// ── Normalized types (vendor-neutral, camelCase) ─────────────

export type ProviderInbox = {
  /** The inbox's stable id — for AgentMail this IS the email address. */
  inboxId: string
  /** The inbox's full address. */
  email: string
  displayName: string | null
}

export type EmailAttachmentInput = {
  filename?: string
  contentType?: string
  /** Base64-encoded bytes. */
  contentBase64?: string
}

export type SendEmailParams = {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  text: string
  html?: string
  attachments?: EmailAttachmentInput[]
}

export type ReplyEmailParams = {
  text: string
  html?: string
  replyAll?: boolean
  /** Override recipients (defaults to the replied message's counterparts). */
  to?: string[]
  attachments?: EmailAttachmentInput[]
}

export type ProviderAttachmentMeta = {
  attachmentId: string
  filename: string | null
  contentType: string | null
  size: number | null
}

export type ProviderEmailMessage = {
  inboxId: string
  threadId: string
  messageId: string
  timestamp: string
  from: string
  to: string[]
  cc: string[]
  subject: string | null
  /** Preferred body: reply-extracted text (quoted history stripped) when available. */
  extractedText: string | null
  text: string | null
  html: string | null
  inReplyTo: string | null
  labels: string[]
  attachments: ProviderAttachmentMeta[]
}

export type ProviderAttachment = ProviderAttachmentMeta & {
  /** Short-lived download URL. */
  downloadUrl: string
  expiresAt: string | null
}

export type ProviderThreadItem = {
  inboxId: string
  threadId: string
  subject: string | null
  preview: string | null
  senders: string[]
  recipients: string[]
  timestamp: string | null
  messageCount: number | null
  lastMessageId: string | null
}

export type CreateDraftParams = {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  text?: string
  html?: string
  attachments?: EmailAttachmentInput[]
  /** Message id this draft replies to (vendor derives threading). */
  inReplyTo?: string
  replyAll?: boolean
  /** ISO 8601 scheduled send. */
  sendAt?: string
  /** Idempotency key. */
  clientId?: string
}

export type ProviderDraft = {
  inboxId: string
  draftId: string
  to: string[]
  cc: string[]
  subject: string | null
  text: string | null
  inReplyTo: string | null
  sendAt: string | null
}

export type ProviderDnsRecord = {
  type: string
  name: string
  value: string
  status: string | null
  priority: number | null
}

export type EmailDomainStatus = 'pending' | 'verified' | 'failed'

export type ProviderEmailDomain = {
  domainId: string
  domain: string
  /** Normalized status; providerStatus keeps the raw vendor value. */
  status: EmailDomainStatus
  providerStatus: string
  records: ProviderDnsRecord[]
}

export type EmailInboxProvider = {
  kind: 'agentmail'
  // Inboxes
  createInbox(params: {
    username?: string
    domain?: string
    displayName?: string
    /** Idempotency key — same key never double-provisions. */
    clientId?: string
    /** External-system linkage mirrored onto the vendor inbox. */
    metadata?: Record<string, string>
  }): Promise<ProviderInbox>
  getInbox(inboxId: string): Promise<ProviderInbox | null>
  deleteInbox(inboxId: string): Promise<void>
  // Messages
  sendMessage(inboxId: string, params: SendEmailParams): Promise<{ messageId: string; threadId: string }>
  replyToMessage(
    inboxId: string,
    messageId: string,
    params: ReplyEmailParams,
  ): Promise<{ messageId: string; threadId: string }>
  getMessage(inboxId: string, messageId: string): Promise<ProviderEmailMessage | null>
  getAttachment(inboxId: string, messageId: string, attachmentId: string): Promise<ProviderAttachment | null>
  // Threads
  listThreads(
    inboxId: string,
    params?: { limit?: number; pageToken?: string; senders?: string[]; subject?: string },
  ): Promise<{ threads: ProviderThreadItem[]; nextPageToken: string | null }>
  // Drafts
  createDraft(inboxId: string, params: CreateDraftParams): Promise<ProviderDraft>
  sendDraft(inboxId: string, draftId: string): Promise<{ messageId: string; threadId: string }>
  deleteDraft(inboxId: string, draftId: string): Promise<void>
  // Domains
  createDomain(domain: string): Promise<ProviderEmailDomain>
  getDomain(domainId: string): Promise<ProviderEmailDomain | null>
  verifyDomain(domainId: string): Promise<ProviderEmailDomain>
  deleteDomain(domainId: string): Promise<void>
  // Webhooks
  createWebhook(inboxId: string, params: { url: string; clientId?: string }): Promise<{ webhookId: string; secret: string }>
  deleteWebhook(inboxId: string, webhookId: string): Promise<void>
  /** Verify an inbound webhook delivery's signature against a signing secret. */
  verifyWebhookSignature(params: { secret: string; headers: SvixHeaders; rawBody: Buffer | string }): boolean
}

// ── AgentMail implementation ─────────────────────────────────

/**
 * The webhook event types we subscribe per inbox. The `.spam` / `.blocked` /
 * `.unauthenticated` received-variants are deliberately absent (plan §6 —
 * they stay un-actioned).
 */
export const AGENTMAIL_SUBSCRIBED_EVENTS = [
  'message.received',
  'message.bounced',
  'message.complained',
  'domain.verified',
] as const

function mapDomainStatus(vendor: string): EmailDomainStatus {
  switch (vendor.toUpperCase()) {
    case 'VERIFIED':
      return 'verified'
    case 'INVALID':
    case 'FAILED':
      return 'failed'
    default:
      // NOT_STARTED | PENDING | VERIFYING
      return 'pending'
  }
}

function mapAttachments(attachments?: EmailAttachmentInput[]): AgentmailSendAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined
  return attachments.map((a) => ({
    filename: a.filename,
    content_type: a.contentType,
    content: a.contentBase64,
  }))
}

export function createAgentmailEmailProvider(client: AgentmailClient): EmailInboxProvider {
  return {
    kind: 'agentmail',

    async createInbox(params) {
      const inbox = await client.createInbox({
        username: params.username,
        domain: params.domain,
        display_name: params.displayName,
        client_id: params.clientId,
        metadata: params.metadata,
      })
      return {
        inboxId: inbox.inbox_id,
        // The address is the inbox id when the API omits `email`.
        email: inbox.email ?? inbox.inbox_id,
        displayName: inbox.display_name ?? null,
      }
    },
    async getInbox(inboxId) {
      const inbox = await client.getInbox(inboxId)
      if (!inbox) return null
      return {
        inboxId: inbox.inbox_id,
        email: inbox.email ?? inbox.inbox_id,
        displayName: inbox.display_name ?? null,
      }
    },
    async deleteInbox(inboxId) {
      await client.deleteInbox(inboxId)
    },

    async sendMessage(inboxId, params) {
      const result = await client.sendMessage(inboxId, {
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        text: params.text,
        html: params.html,
        attachments: mapAttachments(params.attachments),
      })
      return { messageId: result.message_id, threadId: result.thread_id }
    },
    async replyToMessage(inboxId, messageId, params) {
      const result = await client.replyToMessage(inboxId, messageId, {
        text: params.text,
        html: params.html,
        reply_all: params.replyAll,
        to: params.to,
        attachments: mapAttachments(params.attachments),
      })
      return { messageId: result.message_id, threadId: result.thread_id }
    },
    async getMessage(inboxId, messageId) {
      const m = await client.getMessage(inboxId, messageId)
      if (!m) return null
      return {
        inboxId: m.inbox_id,
        threadId: m.thread_id,
        messageId: m.message_id,
        timestamp: m.timestamp,
        from: m.from,
        to: m.to,
        cc: m.cc ?? [],
        subject: m.subject ?? null,
        extractedText: m.extracted_text ?? null,
        text: m.text ?? null,
        html: m.html ?? null,
        inReplyTo: m.in_reply_to ?? null,
        labels: m.labels,
        attachments: (m.attachments ?? []).map((a) => ({
          attachmentId: a.attachment_id,
          filename: a.filename ?? null,
          contentType: a.content_type ?? null,
          size: a.size ?? null,
        })),
      }
    },
    async getAttachment(inboxId, messageId, attachmentId) {
      const a = await client.getAttachment(inboxId, messageId, attachmentId)
      if (!a) return null
      return {
        attachmentId: a.attachment_id ?? attachmentId,
        filename: a.filename ?? null,
        contentType: a.content_type ?? null,
        size: a.size ?? null,
        downloadUrl: a.download_url,
        expiresAt: a.expires_at ?? null,
      }
    },

    async listThreads(inboxId, params) {
      const list = await client.listThreads(inboxId, {
        limit: params?.limit,
        page_token: params?.pageToken,
        senders: params?.senders,
        subject: params?.subject ? [params.subject] : undefined,
      })
      return {
        threads: list.threads.map((t) => ({
          inboxId: t.inbox_id,
          threadId: t.thread_id,
          subject: t.subject ?? null,
          preview: t.preview ?? null,
          senders: t.senders ?? [],
          recipients: t.recipients ?? [],
          timestamp: t.timestamp ?? null,
          messageCount: t.message_count ?? null,
          lastMessageId: t.last_message_id ?? null,
        })),
        nextPageToken: list.next_page_token ?? null,
      }
    },

    async createDraft(inboxId, params) {
      const d = await client.createDraft(inboxId, {
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject: params.subject,
        text: params.text,
        html: params.html,
        attachments: mapAttachments(params.attachments),
        in_reply_to: params.inReplyTo,
        reply_all: params.replyAll,
        send_at: params.sendAt,
        client_id: params.clientId,
      })
      return {
        inboxId: d.inbox_id,
        draftId: d.draft_id,
        to: d.to ?? [],
        cc: d.cc ?? [],
        subject: d.subject ?? null,
        text: d.text ?? null,
        inReplyTo: d.in_reply_to ?? null,
        sendAt: d.send_at ?? null,
      }
    },
    async sendDraft(inboxId, draftId) {
      const result = await client.sendDraft(inboxId, draftId)
      return { messageId: result.message_id, threadId: result.thread_id }
    },
    async deleteDraft(inboxId, draftId) {
      await client.deleteDraft(inboxId, draftId)
    },

    async createDomain(domain) {
      const d = await client.createDomain({ domain, feedback_enabled: true })
      return mapDomain(d)
    },
    async getDomain(domainId) {
      const d = await client.getDomain(domainId)
      return d ? mapDomain(d) : null
    },
    async verifyDomain(domainId) {
      const d = await client.verifyDomain(domainId)
      return mapDomain(d)
    },
    async deleteDomain(domainId) {
      await client.deleteDomain(domainId)
    },

    async createWebhook(inboxId, params) {
      const w = await client.createWebhook(inboxId, {
        url: params.url,
        event_types: [...AGENTMAIL_SUBSCRIBED_EVENTS],
        client_id: params.clientId,
      })
      return { webhookId: w.webhook_id, secret: w.secret }
    },
    async deleteWebhook(inboxId, webhookId) {
      await client.deleteWebhook(inboxId, webhookId)
    },

    verifyWebhookSignature(params) {
      return verifySvixSignature(params)
    },
  }
}

function mapDomain(d: {
  domain_id: string
  domain: string
  status: string
  records: Array<{ type: string; name: string; value: string; status?: string | null; priority?: number | null }>
}): ProviderEmailDomain {
  return {
    domainId: d.domain_id,
    domain: d.domain,
    status: mapDomainStatus(d.status),
    providerStatus: d.status,
    records: d.records.map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      status: r.status ?? null,
      priority: r.priority ?? null,
    })),
  }
}

// ── Factory ──────────────────────────────────────────────────

export type EmailProviderEnv = {
  AGENTMAIL_API_KEY?: string
}

/**
 * Null when no key is configured — the email surface is then dark
 * (provisioning routes 503, webhook unmounted, UI hides the section).
 */
export function createEmailInboxProvider(env: EmailProviderEnv): EmailInboxProvider | null {
  if (!env.AGENTMAIL_API_KEY) return null
  return createAgentmailEmailProvider(createAgentmailClient({ apiKey: env.AGENTMAIL_API_KEY }))
}

// ── Late-bound global (the page-event-fanout seam pattern) ───
//
// `injectMcpTools` runs from many call sites (chat route, channel pipeline,
// workflow executor, public API, scheduler) — threading the provider through
// every one would touch six params chains for one optional dep. Instead boot
// binds the provider once (when AGENTMAIL_API_KEY is set) and the injector
// reads it as its default. Explicit `emailInboxProvider` params still win
// (tests inject their own).

let globalEmailInboxProvider: EmailInboxProvider | null = null

export function setGlobalEmailInboxProvider(provider: EmailInboxProvider | null): void {
  globalEmailInboxProvider = provider
}

export function getGlobalEmailInboxProvider(): EmailInboxProvider | null {
  return globalEmailInboxProvider
}
