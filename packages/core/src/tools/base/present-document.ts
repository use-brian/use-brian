/**
 * Read-only document presentation for the full Chat operator app.
 *
 * The tool result is deliberately a small acknowledgement. The chat route
 * captures the validated tool_input and sends that input to the client as a
 * document_payload event on success, so a long document is not duplicated in
 * provider history as both tool_use input and tool_result output.
 *
 * [COMP:app-web/chat-document-viewer]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'

export const MAX_PRESENTED_DOCUMENT_CHARS = 250_000

export const presentedDocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(512),
  content: z.string().min(1).max(MAX_PRESENTED_DOCUMENT_CHARS),
  format: z.enum(['text', 'markdown']).default('text'),
  sourceName: z.string().trim().min(1).max(512).optional(),
})

export type PresentedDocumentInput = z.infer<typeof presentedDocumentInputSchema>

/** Parse the shared server/client payload boundary without throwing. */
export function parsePresentedDocumentInput(value: unknown): PresentedDocumentInput | null {
  const parsed = presentedDocumentInputSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function createPresentDocumentTool(): Tool {
  return buildTool({
    name: 'presentDocument',
    description:
      'Open a full source document in the Chat app\'s read-only right-hand viewer. ' +
      'Use this when the user explicitly asks to see, open, preview, or read a full document whose complete text you already retrieved. ' +
      'Copy the source into content verbatim: do not reconstruct it from a summary, omit sections, rewrite it, or add commentary inside the document. ' +
      'Use format="text" for ordinary extracted document text and format="markdown" only when the source itself is Markdown. ' +
      'This only presents content; it does not save, edit, or send a file.',
    inputSchema: presentedDocumentInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input) {
      return {
        data: {
          kind: 'document_presented' as const,
          title: input.title,
          format: input.format,
          ...(input.sourceName ? { sourceName: input.sourceName } : {}),
        },
      }
    },
  })
}
