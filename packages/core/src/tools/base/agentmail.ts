/**
 * Assistant Email (AgentMail) tools — the assistant acting on its OWN
 * mailbox from any channel.
 *
 * Identity rule (agentmail.md, plan §5): these tools send from the
 * ASSISTANT'S own address — the recipient sees the assistant's name, never
 * the user's. Gmail sends as the connected human. The two never silently
 * substitute for each other; the descriptions state the identity explicitly
 * and instruct the model to ask rather than fall back.
 *
 * The API surface is inbox-aware: a workspace can hold several assistant
 * inboxes (decision D1), so send/draft/search take an optional `fromInbox`
 * and default to the answering assistant's bound inbox.
 *
 * Egress: sends reuse the Gmail chain — confidential-turn refusal here
 * (WS3 finding #6 pattern), classification `ask` + connector_actions audit
 * at the injection layer.
 *
 * Spec: docs/architecture/integrations/agentmail.md → "Connector tools".
 * Component tag: [COMP:tools/agentmail]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'

export type AgentmailInboxRef = {
  /** The inbox's email address. */
  address: string
  /** True for the answering assistant's bound inbox (the default sender). */
  isDefault: boolean
}

export type AgentmailThreadSummary = {
  threadId: string
  inbox: string
  subject: string | null
  preview: string | null
  senders: string[]
  timestamp: string | null
  messageCount: number | null
}

export type AgentmailToolApi = {
  /** Every assistant inbox usable in this workspace. */
  listInboxes(): Promise<AgentmailInboxRef[]>
  send(params: {
    inboxAddress: string
    to: string[]
    cc?: string[]
    subject: string
    body: string
  }): Promise<{ messageId: string; threadId: string }>
  searchThreads(params: {
    inboxAddress: string
    senders?: string[]
    subjectContains?: string
    limit?: number
  }): Promise<AgentmailThreadSummary[]>
  createDraft(params: {
    inboxAddress: string
    to: string[]
    cc?: string[]
    subject: string
    body: string
    /** ISO 8601 scheduled send time. */
    sendAt?: string
    /** Vendor message id this draft replies to (threading derived vendor-side). */
    inReplyTo?: string
  }): Promise<{ draftId: string; sendAt: string | null }>
}

const CONFIDENTIAL_REFUSAL =
  'This turn is handling confidential workspace content, so the email cannot go out — ' +
  'recipients are outside the workspace and the message could carry it. Share confidential ' +
  'material from the web app instead, or compose the email in a separate turn that does not ' +
  'read confidential data.'

async function resolveInbox(
  api: AgentmailToolApi,
  fromInbox: string | undefined,
): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const inboxes = await api.listInboxes()
  if (inboxes.length === 0) {
    return { ok: false, error: 'This workspace has no assistant inbox yet. Create one in Studio, then try again.' }
  }
  if (fromInbox) {
    const wanted = fromInbox.trim().toLowerCase()
    const match = inboxes.find((i) => i.address.toLowerCase() === wanted)
    if (!match) {
      return {
        ok: false,
        error: `No assistant inbox named ${fromInbox}. Available: ${inboxes.map((i) => i.address).join(', ')}.`,
      }
    }
    return { ok: true, address: match.address }
  }
  const preferred = inboxes.find((i) => i.isDefault) ?? inboxes[0]
  return { ok: true, address: preferred.address }
}

const recipientList = z
  .array(z.string())
  .min(1)
  .max(20)
  .describe('Recipient email addresses.')

export function createAgentmailTools(api: AgentmailToolApi): Tool[] {
  const sendMessage = buildTool({
    name: 'agentmailSendMessage',
    description:
      "Send an email from the assistant's OWN email address (its assistant inbox). " +
      "The recipient sees the assistant's name and address, NOT the user's. " +
      'Call this tool directly — the user will see an Approve/Deny prompt before anything is sent. ' +
      'To email someone as the user themself, use their connected Gmail instead when it is available this turn; ' +
      'if the identity is ambiguous or the preferred sender is unavailable, ask the user which address to send ' +
      'from — never silently substitute one for the other. ' +
      'For a scheduled or reviewable send, create a draft instead.',
    inputSchema: z.object({
      to: recipientList,
      cc: z.array(z.string()).max(20).optional().describe('CC addresses.'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Plain text email body.'),
      fromInbox: z
        .string()
        .optional()
        .describe(
          "Which assistant inbox to send from, as its full address. Omit to use this assistant's own inbox.",
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async execute(input, context) {
      try {
        if (context.sensitivity?.max === 'confidential') {
          return { data: CONFIDENTIAL_REFUSAL, isError: true }
        }
        const inbox = await resolveInbox(api, input.fromInbox)
        if (!inbox.ok) return { data: inbox.error, isError: true }
        const result = await api.send({
          inboxAddress: inbox.address,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          body: input.body,
        })
        return {
          data: {
            sentFrom: inbox.address,
            messageId: result.messageId,
            threadId: result.threadId,
          },
        }
      } catch (err) {
        return { data: `Assistant email error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const searchThreads = buildTool({
    name: 'agentmailSearchThreads',
    description:
      "Search the assistant's own mailbox threads (the assistant inbox — mail people sent TO the assistant " +
      'and its replies). Returns subject, senders, a preview, and timestamps per thread. ' +
      "This is the assistant's mailbox, not the user's personal email.",
    inputSchema: z.object({
      senderContains: z
        .array(z.string())
        .max(10)
        .optional()
        .describe('Only threads whose senders match these substrings (address or name).'),
      subjectContains: z.string().optional().describe('Only threads whose subject contains this text.'),
      limit: z.number().min(1).max(50).optional().describe('Max threads to return (default 10).'),
      fromInbox: z
        .string()
        .optional()
        .describe('Which assistant inbox to search, as its full address. Omit to use the default inbox.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const inbox = await resolveInbox(api, input.fromInbox)
        if (!inbox.ok) return { data: inbox.error, isError: true }
        const threads = await api.searchThreads({
          inboxAddress: inbox.address,
          senders: input.senderContains,
          subjectContains: input.subjectContains,
          limit: input.limit ?? 10,
        })
        return { data: { inbox: inbox.address, threads } }
      } catch (err) {
        return { data: `Assistant email error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createDraft = buildTool({
    name: 'agentmailCreateDraft',
    description:
      "Create an UNSENT draft in the assistant's own mailbox (the assistant inbox — the recipient would see " +
      "the assistant's address, not the user's). Nothing is sent: the draft waits in the mailbox for review, " +
      'or sends itself at `sendAt` when a scheduled time is given. Use this for follow-ups the user wants to ' +
      'review first and for scheduled sends; use the send tool for immediate delivery.',
    inputSchema: z.object({
      to: recipientList,
      cc: z.array(z.string()).max(20).optional().describe('CC addresses.'),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Plain text email body.'),
      sendAt: z
        .string()
        .optional()
        .describe('ISO 8601 time to send the draft automatically. Omit for a draft that only sends when a human sends it.'),
      inReplyTo: z
        .string()
        .optional()
        .describe('Message id this draft replies to (keeps the thread intact).'),
      fromInbox: z
        .string()
        .optional()
        .describe('Which assistant inbox holds the draft, as its full address. Omit to use the default inbox.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async execute(input, context) {
      try {
        // A scheduled draft egresses without another human step, so the
        // confidential-turn refusal applies here exactly as it does to send.
        if (context.sensitivity?.max === 'confidential') {
          return { data: CONFIDENTIAL_REFUSAL, isError: true }
        }
        const inbox = await resolveInbox(api, input.fromInbox)
        if (!inbox.ok) return { data: inbox.error, isError: true }
        const result = await api.createDraft({
          inboxAddress: inbox.address,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          body: input.body,
          sendAt: input.sendAt,
          inReplyTo: input.inReplyTo,
        })
        return {
          data: {
            draftIn: inbox.address,
            draftId: result.draftId,
            sendAt: result.sendAt,
            status: result.sendAt ? 'scheduled' : 'awaiting review',
          },
        }
      } catch (err) {
        return { data: `Assistant email error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [sendMessage, searchThreads, createDraft]
}
