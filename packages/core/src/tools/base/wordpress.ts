/**
 * WordPress managed-content tools.
 *
 * The API layer supplies a client for the fixed Use Brian Bridge routes. The
 * bridge, not the model, owns the catalog of writable page slots.
 *
 * See docs/architecture/integrations/wordpress.md.
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../types.js'

export const WORDPRESS_MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const WORDPRESS_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type WordPressFileBytesReader = (
  context: ToolContext,
  idOrPath: string,
) => Promise<
  | { bytes: Uint8Array; fileName: string; mimeType: string }
  | { error: string; notFound?: boolean }
>

export type WordPressApi = {
  getManagedPage(page: string): Promise<unknown>
  updatePageText(params: {
    page: string
    slot: string
    value: string
    expectedRevision: string
  }): Promise<unknown>
  replacePageImage(params: {
    page: string
    slot: string
    bytes: Uint8Array
    fileName: string
    mimeType: string
    altText: string
    expectedRevision: string
    expectedAttachmentId: number | null
  }): Promise<unknown>
}

type WordPressToolOptions = {
  readFileBytes?: WordPressFileBytesReader
}

function wordPressError(err: unknown): string {
  return `WordPress error: ${err instanceof Error ? err.message : String(err)}`
}

export function createWordPressTools(api: WordPressApi, opts?: WordPressToolOptions): Tool[] {
  const getManagedPage = buildTool({
    name: 'wordpressGetManagedPage',
    description:
      'Read one WordPress page from the site owner\'s managed-content catalog. ' +
      'Returns registered text/image slots, their current values, semantic labels and aliases, optional visual selectors, and a revision required for writes. ' +
      'Use the page and slot ids returned here; never invent a WordPress field, CSS selector, REST path, or option name.',
    inputSchema: z.object({
      page: z.string().min(1).max(100).describe('Managed page id, for example "home".'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        return { data: await api.getManagedPage(input.page) }
      } catch (err) {
        return { data: wordPressError(err), isError: true }
      }
    },
  })

  const updatePageText = buildTool({
    name: 'wordpressUpdatePageText',
    description:
      'Replace the complete value of one registered text slot on a managed WordPress page. ' +
      'First call wordpressGetManagedPage and pass its current revision. This cannot edit arbitrary HTML, blocks, metadata, options, themes, or plugins. ' +
      'Call this tool directly - the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      page: z.string().min(1).max(100).describe('Managed page id from wordpressGetManagedPage.'),
      slot: z.string().min(1).max(100).describe('Registered text slot id from wordpressGetManagedPage.'),
      value: z.string().max(20_000).describe('Complete replacement text for the slot.'),
      expectedRevision: z.string().min(16).max(128).describe('Current page revision from wordpressGetManagedPage.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,
    async execute(input) {
      try {
        return { data: await api.updatePageText(input) }
      } catch (err) {
        return { data: wordPressError(err), isError: true }
      }
    },
  })

  const replacePageImage = buildTool({
    name: 'wordpressReplacePageImage',
    description:
      'Upload a workspace image to the WordPress Media Library and point one registered image slot at the new attachment. ' +
      'The previous attachment is retained for rollback. First call wordpressGetManagedPage and pass its current revision and attachment id. ' +
      'Pass a workspace file id/path or the id from an <attached_file> tag. This cannot replace an image globally or edit an unregistered theme location. ' +
      'Call this tool directly - the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      page: z.string().min(1).max(100).describe('Managed page id from wordpressGetManagedPage.'),
      slot: z.string().min(1).max(100).describe('Registered image slot id from wordpressGetManagedPage.'),
      file: z.string().min(1).describe('Workspace file id, absolute workspace path, or attached-file id.'),
      altText: z.string().max(500).describe('Alt text for accessibility. Use an empty string only for a decorative image.'),
      expectedRevision: z.string().min(16).max(128).describe('Current page revision from wordpressGetManagedPage.'),
      expectedAttachmentId: z.number().int().positive().nullable().describe('Current attachment id from the slot, or null when the slot is empty.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 60_000,
    async execute(input, context) {
      if (!opts?.readFileBytes) {
        return {
          data: 'WordPress images cannot be uploaded from this context because workspace file access is unavailable.',
          isError: true,
        }
      }

      try {
        const file = await opts.readFileBytes(context, input.file)
        if ('error' in file) {
          if (file.notFound) {
            return {
              data: `${file.error} Do not retry with the same id. Ask the user to re-attach the image if it is no longer in the workspace upload cache.`,
              isError: true,
            }
          }
          return { data: file.error, isError: true }
        }
        if (!(WORDPRESS_IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType)) {
          return {
            data: `That file is ${file.mimeType}. WordPress managed image slots accept JPEG, PNG, or WebP images only.`,
            isError: true,
          }
        }
        if (file.bytes.byteLength > WORDPRESS_MAX_IMAGE_BYTES) {
          return {
            data: 'That image is larger than the 20 MB WordPress connector limit.',
            isError: true,
          }
        }

        return {
          data: await api.replacePageImage({
            page: input.page,
            slot: input.slot,
            bytes: file.bytes,
            fileName: file.fileName,
            mimeType: file.mimeType,
            altText: input.altText,
            expectedRevision: input.expectedRevision,
            expectedAttachmentId: input.expectedAttachmentId,
          }),
        }
      } catch (err) {
        return { data: wordPressError(err), isError: true }
      }
    },
  })

  return [getManagedPage, updatePageText, replacePageImage]
}
