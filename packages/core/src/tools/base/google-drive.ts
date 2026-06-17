/**
 * Google Drive tools — list, get metadata, read content, create, and update files.
 *
 * Read tools are concurrency-safe; write tools require confirmation.
 * The `api` callback is injected by the API layer so core stays
 * free of network/OAuth deps.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'

/**
 * A file the user has explicitly picked via the Google Picker.
 * Writes against these files skip the confirmation prompt — the pick itself
 * is the consent ceremony. See docs/architecture/integrations/mcp.md →
 * "The `gdrive` connector — `drive.file` + Google Picker".
 */
export type AuthorizedFile = {
  id: string
  name: string
  mimeType: string
  addedAt: string
}

function isAuthorized(fileId: string | undefined, authorized: AuthorizedFile[]): boolean {
  if (!fileId || !authorized.length) return false
  return authorized.some((f) => f.id === fileId)
}

export type GoogleDriveApi = {
  listFiles(params: {
    query?: string
    maxResults?: number
    folderId?: string
  }): Promise<unknown>

  getFile(fileId: string): Promise<unknown>

  getFileContent(fileId: string, exportMimeType?: string): Promise<unknown>

  createFile(params: {
    name: string
    content: string
    mimeType?: string
    folderId?: string
  }): Promise<unknown>

  updateFile(fileId: string, params: {
    name?: string
    content?: string
  }): Promise<unknown>
}

export function createGoogleDriveTools(api: GoogleDriveApi, authorizedFiles: AuthorizedFile[] = []): Tool[] {
  const listFiles = buildTool({
    name: 'googleDriveListFiles',
    description:
      'Search and list files in Google Drive. Returns file names, types, and IDs. ' +
      'Use the query parameter to search by name. Use folderId to list files in a specific folder.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search by file name. Omit to list recent files.'),
      maxResults: z.number().optional().describe('Max files to return (default 20).'),
      folderId: z.string().optional().describe('Folder ID to list files from.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.listFiles({
          query: input.query,
          maxResults: input.maxResults,
          folderId: input.folderId,
        })
        return { data }
      } catch (err) {
        return { data: `Drive error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getFile = buildTool({
    name: 'googleDriveGetFile',
    description: 'Get metadata for a Google Drive file by ID. Returns name, type, size, and link.',
    inputSchema: z.object({
      fileId: z.string().describe('The Drive file ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getFile(input.fileId)
        return { data }
      } catch (err) {
        return { data: `Drive error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getFileContent = buildTool({
    name: 'googleDriveGetFileContent',
    description:
      'Read the content of a Google Drive file. Google Docs are exported as plain text, ' +
      'Sheets as CSV, and other text files are returned as-is. Use this for reading file contents.',
    inputSchema: z.object({
      fileId: z.string().describe('The Drive file ID to read.'),
      exportMimeType: z.string().optional().describe('Override export MIME type (e.g. "text/html" for Docs). Defaults to text/plain for Docs, text/csv for Sheets.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 30_000,

    async execute(input) {
      try {
        const data = await api.getFileContent(input.fileId, input.exportMimeType)
        return { data }
      } catch (err) {
        return { data: `Drive error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createFile = buildTool({
    name: 'googleDriveCreateFile',
    description:
      'Create a new file in Google Drive. Provide a name, content, and optional MIME type. ' +
      'For Google Docs, use mimeType "application/vnd.google-apps.document". ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the target folder is whitelisted.',
    inputSchema: z.object({
      name: z.string().describe('File name (e.g. "Meeting Notes.txt").'),
      content: z.string().describe('File content as text.'),
      mimeType: z.string().optional().describe('MIME type (default "text/plain"). Use "application/vnd.google-apps.document" for Google Docs.'),
      folderId: z.string().optional().describe('Parent folder ID. Omit for root.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async resolveConfirmation() {
      // Newly-created files have no ID yet, so they can't be in the authorized
      // list. Keep the prompt — the user consents once, and the returned file
      // should be added to authorizedFiles afterwards if they want to edit it
      // without prompts.
      return true
    },

    async execute(input) {
      try {
        const data = await api.createFile({
          name: input.name,
          content: input.content,
          mimeType: input.mimeType,
          folderId: input.folderId,
        })
        return { data }
      } catch (err) {
        return { data: `Drive error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const updateFile = buildTool({
    name: 'googleDriveUpdateFile',
    description:
      'Update a file in Google Drive — rename it, replace its content, or both. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the file is whitelisted.',
    inputSchema: z.object({
      fileId: z.string().describe('The Drive file ID to update.'),
      name: z.string().optional().describe('New file name.'),
      content: z.string().optional().describe('New file content (replaces entire content).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async resolveConfirmation(_context, input) {
      const fileId = (input as { fileId?: string })?.fileId
      return !isAuthorized(fileId, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.updateFile(input.fileId, {
          name: input.name,
          content: input.content,
        })
        return { data }
      } catch (err) {
        return { data: `Drive error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [
    // Phase 2: requires drive.readonly scope (restricted, needs CASA audit)
    // listFiles,
    // getFile,
    // getFileContent,

    // Phase 1.5: requires drive.file scope (non-sensitive, add with Picker UI)
    // createFile,
    // updateFile,
  ]
}
