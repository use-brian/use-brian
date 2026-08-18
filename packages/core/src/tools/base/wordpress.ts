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

/**
 * The api client (`packages/api/src/wordpress/client.ts`) throws
 * `WordPressConnectorError` with a typed `code` (+ HTTP `status`) and a
 * safe one-line message. The tool result used to drop both and ship
 * `WordPress error: <message>` — so `invalid_credentials` never carried the
 * `(401)` / "invalid or expired" markers the health classifier flips on, and
 * the model got no next step. Render per code: what / why / next step /
 * verdict, keeping the code and status in the sentence.
 * Standard: docs/architecture/engine/tool-executor.md → "Failure copy".
 */
function wordPressError(err: unknown, tool: string, target: string): { data: string; isError: true } {
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : undefined
  const status = typeof e?.status === 'number' ? e.status : undefined
  const message = err instanceof Error ? err.message : String(err)
  const tag = code ? `WordPress bridge error ${code}${status ? ` (${status})` : ''}` : `WordPress error${status ? ` (${status})` : ''}`
  const doing = `\`${tool}\` on ${target}`
  const said = message ? ` ${message}.` : ''
  switch (code) {
    case 'invalid_credentials':
      return { data: `WordPress rejected this connector's credential while running ${doing} (${tag}): the stored username / Application Password is invalid or expired.${said} Reconnect WordPress (Studio → Connectors) — retrying will not help until it is reconnected.`, isError: true }
    case 'forbidden':
      return { data: `WordPress refused ${doing} (${tag}): the connected WordPress user does not have permission for this managed content — the resource is not accessible to that role.${said} This is a permission on the site, not a problem with the connector as a whole: ask the site owner to grant the user the managed-content capability, or pick content that user may edit. Retrying unchanged will fail the same way.`, isError: true }
    case 'bridge_required':
      return { data: `WordPress could not run ${doing} (${tag}): the Use Brian Bridge plugin is not installed, not active, or not reachable at the configured site URL.${said} Nothing about the arguments is wrong and retrying will not help — ask the site owner to install / activate the Bridge plugin (or fix the site URL in Studio → Connectors), then retry.`, isError: true }
    case 'managed_page_not_found':
      return { data: `WordPress has no managed page ${target} in this site's managed-content catalog (${tag}).${said} Page ids come from the site owner's catalog, never from a URL slug or title guess — ask the user which managed page they mean (the catalog is what \`wordpressGetManagedPage\` reads); retrying this exact id will keep failing.`, isError: true }
    case 'managed_slot_not_found':
      return { data: `WordPress has no managed slot for ${doing} (${tag}).${said} Call \`wordpressGetManagedPage\` for that page and use one of the slot ids it returns (never a CSS selector or an invented field name); retrying this exact slot will keep failing.`, isError: true }
    case 'wrong_slot_type':
      return { data: `WordPress refused ${doing} (${tag}): that managed slot has a different content type.${said} Read the page with \`wordpressGetManagedPage\` and use \`wordpressUpdatePageText\` for text slots and \`wordpressReplacePageImage\` for image slots; the same slot with this tool will fail the same way.`, isError: true }
    case 'revision_conflict':
    case 'attachment_conflict':
      return { data: `WordPress rejected ${doing} because of a conflict (${tag}): the page (or its image) changed after it was read, so \`expectedRevision\` / \`expectedAttachmentId\` no longer match. Nothing was changed. Call \`wordpressGetManagedPage\` again, take the current revision / attachment id, and retry once with those; do not resend the stale values.`, isError: true }
    case 'unsupported_image':
      return { data: `WordPress rejected the image for ${doing} (${tag}).${said} Nothing was changed. Use a JPEG, PNG or WebP file the site accepts; the same file will fail the same way.`, isError: true }
    case 'file_too_large':
      return { data: `WordPress rejected the image for ${doing} because it exceeds the site's upload limit (${tag}).${said} Nothing was changed. Use a smaller file (or ask the site owner to raise the WordPress upload limit); the same file will fail the same way.`, isError: true }
    case 'timeout':
      return { data: `WordPress did not respond in time for ${doing} (${tag}).${said} Nothing about the input is wrong — this is transient (a slow site or bridge). A write may or may not have been applied: read the page back before repeating it. Retry once after a short wait; if it persists, tell the user.`, isError: true }
    case 'invalid_site_url':
      return { data: `WordPress could not be called for ${doing} (${tag}): the connector's site URL is missing or not a valid HTTPS URL.${said} Nothing about the arguments is wrong and retrying will not help — the connector must be reconfigured (Studio → Connectors); tell the user.`, isError: true }
    case 'bridge_error':
      return { data: `The WordPress bridge could not complete ${doing} (${tag}).${said} This is a site-side / bridge failure, not a bad argument: retry once after a short wait; if it persists, tell the user to check the Use Brian Bridge plugin on their site.`, isError: true }
    default:
      return { data: `WordPress ${doing} failed (${tag}): ${message} Retrying the same arguments will not help — fix what the message names, or ask the user.`, isError: true }
  }
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
        return wordPressError(err, 'wordpressGetManagedPage', `page \`${input.page}\``)
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
        return wordPressError(err, 'wordpressUpdatePageText', `slot \`${input.slot}\` of page \`${input.page}\``)
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
          data: 'wordpressReplacePageImage cannot run on this surface: the workspace file reader (`readFileBytes`) is not wired here, so an uploaded image cannot be read. Nothing about the arguments is wrong and retrying will not help — ask the user to attach the image in a workspace chat (web / Telegram / Slack) where files are available, and run the replacement from there.',
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
            data: `That file is ${file.mimeType}; WordPress managed image slots accept JPEG, PNG, or WebP images only. Nothing was uploaded. Ask the user for an image in one of those formats and retry with that; the same file will fail the same way.`,
            isError: true,
          }
        }
        if (file.bytes.byteLength > WORDPRESS_MAX_IMAGE_BYTES) {
          return {
            data: `That image is ${(file.bytes.byteLength / (1024 * 1024)).toFixed(1)} MB, larger than the ${Math.round(WORDPRESS_MAX_IMAGE_BYTES / (1024 * 1024))} MB WordPress connector limit. Nothing was uploaded. Ask the user for a smaller file (or resize it) and retry with that; the same file will fail the same way.`,
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
        return wordPressError(err, 'wordpressReplacePageImage', `slot \`${input.slot}\` of page \`${input.page}\``)
      }
    },
  })

  return [getManagedPage, updatePageText, replacePageImage]
}
