/**
 * Gmail tools — list, read, and send messages.
 *
 * Read tools are concurrency-safe; send requires confirmation.
 * The `callApi` callback is injected by the API layer so core stays
 * free of network/OAuth deps.
 *
 * `gmailSendMessage` optionally attaches workspace (brain) files as real
 * MIME attachments: core resolves id/path → bytes via the injected
 * `FilesApi` (same gates + access ceiling as `sendFile`) and hands the
 * resolved parts to the API layer, which builds the multipart message.
 * See docs/architecture/integrations/gmail.md → "Attachments".
 * [COMP:tools/gmail-attachments]
 *
 * `gmailSendMessage` also takes an optional `from` alias: core passes it
 * through untouched (no alias validation here — the API layer sets the
 * `From:` header and Gmail itself enforces that it is a verified "Send
 * mail as" identity on the connected account). See
 * docs/architecture/integrations/gmail.md → "Send As".
 * [COMP:tools/gmail-send-as]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, str } from './_connector-result.js'
import type { FilesApi } from '../../workspace-files/api.js'
import { ctxFor, errorMessage, idOrPathShape, workspaceGate } from '../../workspace-files/tool-helpers.js'

/** A resolved outgoing attachment — the `OutgoingDocument` shape channels use. */
export type GmailOutgoingAttachment = {
  filename: string
  mime: string
  data: Uint8Array
}

/**
 * Caps sized to Gmail, not to messaging channels: 18 MB raw → ~24.7 MB
 * after base64, inside Gmail's 25 MB message ceiling (and the 35 MB
 * upload-transport cap) with headroom for body + headers.
 */
export const MAX_EMAIL_ATTACHMENTS = 10
export const MAX_EMAIL_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024

export type GmailApi = {
  listMessages(params: {
    query?: string
    maxResults?: number
  }): Promise<unknown>

  getMessage(messageId: string): Promise<unknown>

  sendMessage(params: {
    to: string
    from?: string
    subject: string
    body: string
    attachments?: GmailOutgoingAttachment[]
  }): Promise<unknown>
}

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return formatMb(bytes)
}

export function createGmailTools(api: GmailApi, opts?: { filesApi?: FilesApi }): Tool[] {
  const listMessages = buildTool({
    name: 'gmailListMessages',
    description:
      'Search Gmail messages. Returns sender, subject, date, and a snippet for each result. ' +
      'Use Gmail search syntax for the query (e.g. "from:alice subject:invoice after:2026/04/01").',
    inputSchema: z.object({
      query: z.string().optional().describe('Gmail search query. Omit to list recent messages.'),
      maxResults: z.number().optional().describe('Max messages to return (default 10).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.listMessages({
          query: input.query,
          maxResults: input.maxResults,
        })
        return { data }
      } catch (err) {
        return { data: `Gmail error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getMessage = buildTool({
    name: 'gmailGetMessage',
    description: 'Get the full content of a Gmail message by ID. Returns from, to, subject, date, and body text.',
    inputSchema: z.object({
      messageId: z.string().describe('The Gmail message ID to fetch.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getMessage(input.messageId)
        return { data }
      } catch (err) {
        return { data: `Gmail error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const sendMessage = buildTool({
    name: 'gmailSendMessage',
    description:
      'Send an email via Gmail. ' +
      'The email is sent from the authenticated user\'s account by default. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt. ' +
      'To send from a different address, pass `from` — it must already be a verified "Send mail as" alias ' +
      'configured in the connected account\'s Gmail settings; Gmail rejects the send otherwise, so never ' +
      'guess an alias the user has not confirmed exists. ' +
      'Workspace files can be attached as real email attachments (the recipient gets the file itself, never a link): ' +
      'pass their ids or paths in `attachments`. Only files already saved in the workspace brain can be attached; ' +
      'confidential files cannot be emailed. Limits: 10 attachments, 18 MB total. ' +
      'If attaching fails, relay the reason honestly — never claim a file was attached when it was not.',
    inputSchema: z.object({
      to: z.string().describe('Recipient email address.'),
      from: z
        .string()
        .optional()
        .describe(
          'Send as this address instead of the primary account. Must be a verified "Send mail as" alias ' +
          'already configured in the connected Gmail account\'s settings — Gmail rejects the send if it is not.',
        ),
      subject: z.string().describe('Email subject line.'),
      body: z.string().describe('Plain text email body.'),
      attachments: z
        .array(idOrPathShape)
        .max(MAX_EMAIL_ATTACHMENTS)
        .optional()
        .describe(
          'Workspace files to attach — each entry a file id or absolute workspace path ' +
          '(from the workspace files index or a file search). Attached as real MIME parts.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    // Approve/Deny preview. The model passes attachments as ids, so the
    // generic key-value renderer would show raw UUIDs. With attachments
    // present this takes over the WHOLE preview (displayLines replaces the
    // generic renderer on every surface), so it must carry to/subject/body
    // too. stat is metadata-only under the caller's read ceiling — the same
    // projection the send itself applies. Null → generic renderer.
    async describeConfirmation(input, context) {
      const { to, from, subject, body, attachments } = (input ?? {}) as {
        to?: unknown
        from?: unknown
        subject?: unknown
        body?: unknown
        attachments?: unknown
      }
      if (!Array.isArray(attachments) || attachments.length === 0) return null
      const filesApi = opts?.filesApi
      if (!filesApi || !context.workspaceId) return null

      const ctx = ctxFor(context)
      const refs = attachments.filter((r): r is string => typeof r === 'string')
      const stats = await Promise.all(refs.map((ref) => filesApi.stat(ctx, ref)))

      const lines: string[] = []
      if (typeof from === 'string') lines.push(`• From: ${from}`)
      if (typeof to === 'string') lines.push(`• To: ${to}`)
      if (typeof subject === 'string') lines.push(`• Subject: ${subject}`)
      if (typeof body === 'string') lines.push(`• Body: ${body}`)

      const seen = new Set<string>()
      for (let i = 0; i < refs.length; i++) {
        const result = stats[i]
        if (!result.ok) {
          lines.push(`• Attachment: ${refs[i]} (not found)`)
          continue
        }
        const f = result.value
        if (seen.has(f.id)) continue
        seen.add(f.id)
        lines.push(
          f.sensitivity === 'confidential'
            ? `• Attachment: ${f.name} (confidential: send will be refused)`
            : `• Attachment: ${f.name} (${formatSize(f.sizeBytes)})`,
        )
      }
      return lines
    },

    async execute(input, context) {
      try {
        let attachments: GmailOutgoingAttachment[] | undefined
        if (input.attachments && input.attachments.length > 0) {
          const filesApi = opts?.filesApi
          if (!filesApi) {
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

          // Resolve metadata first (viewer-projected — the acting user's read
          // ceiling applies) and run every gate BEFORE any bytes are read.
          const seen = new Set<string>()
          const files: Array<{ id: string; path: string; name: string; mime: string; sizeBytes: number }> = []
          for (const ref of input.attachments) {
            const result = await filesApi.stat(ctx, ref)
            if (!result.ok) {
              return { data: errorMessage(result.error), isError: true }
            }
            const file = result.value
            if (seen.has(file.id)) continue
            seen.add(file.id)
            if (file.sensitivity === 'confidential') {
              return {
                data: `${file.path} is confidential and cannot be emailed — email recipients are outside the workspace. Tell the user to share it from the web app instead.`,
                isError: true,
              }
            }
            files.push({ id: file.id, path: file.path, name: file.name, mime: file.mime, sizeBytes: file.sizeBytes })
          }

          const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
          if (totalBytes > MAX_EMAIL_ATTACHMENT_TOTAL_BYTES) {
            return {
              data:
                `Attachments total ${formatMb(totalBytes)} — over the ${formatMb(MAX_EMAIL_ATTACHMENT_TOTAL_BYTES)} email limit. ` +
                'Send fewer or smaller files, or tell the user to share the large ones from the web app.',
              isError: true,
            }
          }

          attachments = []
          for (const f of files) {
            const read = await filesApi.readBytes(ctx, f.id)
            if (!read.ok) {
              return { data: errorMessage(read.error), isError: true }
            }
            attachments.push({ filename: f.name, mime: f.mime, data: read.value.bytes })
          }
        }

        const data = await api.sendMessage({
          to: input.to,
          subject: input.subject,
          body: input.body,
          ...(input.from ? { from: input.from } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        })
        const m = (data ?? {}) as Json
        return {
          data: {
            id: str(m, 'id'),
            threadId: str(m, 'threadId'),
            ...(attachments && attachments.length > 0
              ? { attached: attachments.map((a) => a.filename) }
              : {}),
          },
        }
      } catch (err) {
        return { data: `Gmail error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [
    // Phase 2: requires gmail.readonly scope (restricted, needs CASA audit)
    // listMessages,
    // getMessage,
    sendMessage,
  ]
}
