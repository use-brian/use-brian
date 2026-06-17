/**
 * Google Docs tools — read content, append text, and find-and-replace.
 *
 * Read tools are concurrency-safe; write tools require confirmation.
 * The `api` callback is injected by the API layer so core stays
 * free of network/OAuth deps.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import type { AuthorizedFile } from './google-drive.js'

export type GoogleDocsApi = {
  getContent(documentId: string): Promise<unknown>
  appendText(documentId: string, text: string): Promise<unknown>
  replaceText(documentId: string, findText: string, replaceText: string): Promise<unknown>
  create(title: string): Promise<{ documentId: string; title: string; url: string }>
}

function isAuthorized(id: string | undefined, authorized: AuthorizedFile[]): boolean {
  if (!id) return false
  return authorized.some((f) => f.id === id)
}

export function createGoogleDocsTools(api: GoogleDocsApi, authorizedFiles: AuthorizedFile[] = []): Tool[] {
  const getContent = buildTool({
    name: 'googleDocsGetContent',
    description:
      'Read the full text content of a Google Doc by its document ID. ' +
      'Returns the document title and body as plain text.',
    inputSchema: z.object({
      documentId: z.string().describe('The Google Docs document ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.getContent(input.documentId)
        return { data }
      } catch (err) {
        return { data: `Docs error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const appendText = buildTool({
    name: 'googleDocsAppendText',
    description:
      'Append text to the end of a Google Doc. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the document is already in their authorized files list.',
    inputSchema: z.object({
      documentId: z.string().describe('The Google Docs document ID.'),
      text: z.string().describe('Text to append to the document.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async resolveConfirmation(_context, input) {
      const docId = (input as { documentId?: string })?.documentId
      return !isAuthorized(docId, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.appendText(input.documentId, input.text)
        return { data: data ?? 'Text appended successfully.' }
      } catch (err) {
        return { data: `Docs error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const replaceText = buildTool({
    name: 'googleDocsReplaceText',
    description:
      'Find and replace all occurrences of a text string in a Google Doc. Case-sensitive. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the document is already in their authorized files list.',
    inputSchema: z.object({
      documentId: z.string().describe('The Google Docs document ID.'),
      findText: z.string().describe('The text to find (case-sensitive).'),
      replaceText: z.string().describe('The replacement text.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async resolveConfirmation(_context, input) {
      const docId = (input as { documentId?: string })?.documentId
      return !isAuthorized(docId, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.replaceText(input.documentId, input.findText, input.replaceText)
        return { data }
      } catch (err) {
        return { data: `Docs error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const create = buildTool({
    name: 'googleDocsCreate',
    description:
      'Create a new, empty Google Doc with the given title. ' +
      'Returns the document ID and URL. After creation, the file is auto-added ' +
      'to the user\'s authorized files so subsequent edits (googleDocsAppendText, ' +
      'googleDocsReplaceText) do not re-prompt. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt for this initial create.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Document title (e.g. "Meeting Notes 2026-04-22").'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,

    async resolveConfirmation() {
      return true
    },

    async execute(input) {
      try {
        const data = await api.create(input.title)
        return { data }
      } catch (err) {
        return { data: `Docs error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [getContent, appendText, replaceText, create]
}
