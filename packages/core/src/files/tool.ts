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
      if (!file) return { data: 'File not found or expired.', isError: true }

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
