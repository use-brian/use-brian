/**
 * `sendFile` — deliver a workspace file to the current channel as a real
 * document (Telegram document message, Slack file upload, web attachment
 * card). The outbound counterpart of `saveFileToBrain`.
 *
 * The tool moves NO bytes: it resolves metadata via `FilesApi.stat`, runs
 * the gates (delivery surface → sensitivity → caps), and registers an
 * `OutboundAttachment` on `ToolContext.outboundAttachments`. The channel
 * route drains the collector at `turn_complete` and resolves bytes via
 * `FilesApi.readBytes` only for documents that actually deliver.
 *
 * See docs/architecture/features/files.md → "`sendFile`" and
 * docs/architecture/channels/adapter-pattern.md → "Outbound documents".
 * [COMP:files/send-file]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { FilesApi } from './api.js'
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_EXTERNAL_DOCUMENT_BYTES,
} from './attachments.js'
import { ctxFor, errorMessage, idOrPathShape, workspaceGate } from './tool-helpers.js'

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

export function createSendFileTool(api: FilesApi): Tool {
  return buildTool({
    name: 'sendFile',
    requiresCapability: 'files',
    isConcurrencySafe: true,
    // Reads the brain, writes nothing — the side effect (delivery) is owned
    // by the channel route after the turn.
    isReadOnly: true,
    description:
      'Attach an existing workspace file to your reply as a real document (a downloadable file in the chat), preserving the original bytes. ' +
      'Use when the user asks you to send / share / give them a file from the brain. To send freshly written content, first save it with fileWrite, then call sendFile with the saved path. ' +
      'The file is delivered alongside your message — do NOT paste its contents into the reply. ' +
      'Confidential files can only be attached in web chat. Limits: 5 attachments per reply; 45 MB per file on messaging channels. ' +
      'If this tool returns an error, relay the reason honestly — never claim a file was sent when it was not.',
    inputSchema: z.object({
      file: idOrPathShape.describe('UUID or absolute workspace path of the file to attach.'),
      caption: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .describe('Optional short caption shown with the document (plain text).'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      // ── Gate 1: delivery surface ──
      const collector = context.outboundAttachments
      if (!collector) {
        return {
          data:
            'File attachments cannot be delivered from this context — no chat channel is attached to this turn. ' +
            'Tell the user to ask in a direct chat (web, Telegram, or Slack) instead.',
          isError: true,
        }
      }
      if (context.channelType === 'whatsapp') {
        return {
          data:
            'File attachments are not supported on WhatsApp. Tell the user to fetch the file from the web app, or to ask again on web chat, Telegram, or Slack.',
          isError: true,
        }
      }

      const result = await api.stat(ctxFor(context), input.file)
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      const file = result.value

      // ── Gate 2: sensitivity (external channels put bytes on third-party servers) ──
      const external = context.channelType !== 'web'
      if (external && file.sensitivity === 'confidential') {
        return {
          data: `${file.path} is confidential and can only be shared in the web app chat. Tell the user to open it there — do not paste its contents here.`,
          isError: true,
        }
      }

      // ── Gate 3: caps ──
      if (external && file.sizeBytes > MAX_EXTERNAL_DOCUMENT_BYTES) {
        return {
          data: `${file.path} is ${formatMb(file.sizeBytes)} — over the ${formatMb(MAX_EXTERNAL_DOCUMENT_BYTES)} limit for messaging channels. Tell the user to download it from the web app.`,
          isError: true,
        }
      }

      const outcome = collector.note({
        fileId: file.id,
        workspaceId: context.workspaceId!,
        path: file.path,
        name: file.name,
        mime: file.mime,
        sizeBytes: file.sizeBytes,
        caption: input.caption,
      })
      if (outcome === 'cap_reached') {
        return {
          data: `Attachment limit reached for this reply (${MAX_ATTACHMENTS_PER_TURN}). Send the remaining files in a follow-up message.`,
          isError: true,
        }
      }
      if (outcome === 'duplicate') {
        return { data: `${file.path} is already attached to this reply.` }
      }
      return {
        data: `Attached ${file.path} (${file.sizeBytes} bytes, ${file.mime}) to this reply. It will be delivered with your message — do not paste its contents.`,
      }
    },
  })
}
