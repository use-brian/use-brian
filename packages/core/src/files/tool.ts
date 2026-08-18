import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { FileStore } from './types.js'

/**
 * readFileContent tool — retrieves full cached file content on demand.
 */
export function createReadFileTool(store: FileStore): Tool {
  return buildTool({
    name: 'readFileContent',
    description: 'Read the full content of a previously uploaded file. Use when you need more detail than the inline summary provided.',
    inputSchema: z.object({
      fileId: z.string().describe('File ID from the cached file reference'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultSizeChars: 50_000,

    async execute(input) {
      const file = await store.get(input.fileId)
      if (!file) {
        // The upload cache is time-boxed (`expires_at`) and there is
        // deliberately no listing tool over it: the ONLY source of a valid
        // fileId is an `<attached_file id="…">` tag in this conversation, so a
        // miss ends the search rather than starting one.
        return {
          data:
            `No cached upload with id ${input.fileId} — it is not in this conversation's upload cache, or it has expired (uploads are held for a limited window, not forever). ` +
            'File ids for this tool come only from an `<attached_file id="…">` tag in the conversation; there is no tool that lists cached uploads, so re-read the tag rather than guessing an id. ' +
            'If no live tag carries it, ask the user to re-attach the file — and never describe contents you have not read. ' +
            'Do NOT retry this exact id.',
          isError: true,
        }
      }

      return {
        data: {
          fileName: file.fileName,
          mimeType: file.mimeType,
          content: file.content,
          sizeBytes: file.sizeBytes,
        },
      }
    },
  })
}
