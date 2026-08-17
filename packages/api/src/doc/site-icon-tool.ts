/**
 * `fetchSiteIcon` — the doc chat tool that fetches a website's real
 * icon/logo and stores it as an IMAGE page icon.
 *
 * Flow: the model calls this with a domain / site URL / direct image URL
 * (e.g. a client page named `theground.io`), the server resolves the best
 * icon deterministically (`./site-icon.ts`: apple-touch-icon > rel icon >
 * og:image > /favicon.ico — SSRF-guarded, size/type-capped, no search
 * provider involved), stores the bytes as a workspace file (the same
 * GCS-backed store the doc upload route writes, served back through
 * `GET /api/doc-files/:workspaceId/:id`), and returns an
 * `img:<workspaceId>/<fileId>` token. The model then applies it with the
 * regular `patchPage` `setIcon` op (or `renderPage` / `createSubPage`
 * `icon` arg) — so the persist, undo, `page_patched` meta event, and the
 * `doc_title_update` live-sync all ride the existing icon pipeline;
 * this tool never writes `saved_views` itself.
 *
 * Injected by `./inject.ts` on doc-surface turns when a `FilesApi` is
 * wired (tool-awareness rule: absent files storage → absent tool).
 * Follows the `refineActiveTheme` pattern of a packages/api-owned doc tool.
 *
 * Spec: docs/architecture/features/doc.md → "Image icons".
 *
 * [COMP:api/site-icon-tool]
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, workspaceFilesErrorMessage, type FilesApi, type Tool } from '@use-brian/core'
import { imageIconToken } from '@use-brian/shared'

import { fetchSiteIconImage, type BytesFetchFn } from './site-icon.js'

export type FetchSiteIconDeps = {
  filesApi: FilesApi
  /** The workspace the doc surface is operating over (from inject options). */
  workspaceId: string
  /** Test seam; defaults to global fetch inside `fetchSiteIconImage`. */
  fetchFn?: BytesFetchFn
  /** Test seam; defaults to the DNS-aware SSRF validator. */
  validate?: (raw: string) => Promise<URL | null> | URL | null
}

const inputSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      "The site to take the icon from: a bare domain ('theground.io'), a site URL, or a direct image URL (e.g. a logo PNG you found). For a company/client page named after its domain, pass the domain.",
    ),
})

/**
 * Per-cause failure copy. Every branch names WHAT did not happen (no icon was
 * fetched and no page changed), WHY, the NEXT step, and whether the same `url`
 * can ever succeed — a bare "fetch failed" sent the model round the same
 * domain again. `patchPage setIcon` with an emoji is the standing fallback,
 * and it is named because this tool only runs on doc-surface turns where
 * `patchPage` is injected alongside it.
 */
const ERROR_HINTS: Record<string, (url: string) => string> = {
  invalid_url: (url) =>
    `No icon was fetched for ${JSON.stringify(url)} and no page was changed: that value is not a fetchable public web address (malformed, not http/https, or it resolves to a private/internal address that this tool refuses on purpose). ` +
    'Re-issue with a public domain ("theground.io"), a full site URL, or a direct image URL. This exact value will be rejected the same way every time.',
  fetch_failed: (url) =>
    `No icon was fetched for ${JSON.stringify(url)} and no page was changed: the site never answered, or it redirected in a loop. ` +
    'Check the domain is spelled right and is actually live; if it is, pass a direct image URL for the logo instead. ' +
    'A single retry is worth it only if the site is known to be up - otherwise change the argument rather than repeating it.',
  no_icon_found: (url) =>
    `No icon was fetched for ${JSON.stringify(url)} and no page was changed: the site answered, but published no usable icon (no apple-touch-icon, no rel=icon, no og:image in an accepted image format). ` +
    'Retrying this domain will keep finding nothing. Pass a direct image URL for the logo if you have one, or set an emoji icon instead with patchPage { op: "setIcon", icon: "<emoji>" }.',
}

export function createFetchSiteIconTool(deps: FetchSiteIconDeps): Tool {
  return buildTool({
    name: 'fetchSiteIcon',
    description:
      "Fetch a website's real icon/logo (apple-touch-icon / favicon / social image) and store it as an image page icon. " +
      "Use when the user wants a page's icon to be an actual brand logo instead of an emoji — e.g. a client page named after the company's domain. " +
      'Accepts a bare domain, a site URL, or a direct image URL. ' +
      'Returns an `icon` token ("img:...") — apply it with the patchPage `setIcon` op (or the renderPage/createSubPage `icon` argument); the tool itself does not change any page. ' +
      'Cheap and read-only on the web side; safe to call once per site.',
    inputSchema,
    isConcurrencySafe: true,
    isReadOnly: false,
    timeoutMs: 30_000,

    async execute(input, context) {
      const result = await fetchSiteIconImage(input.url, deps.fetchFn, deps.validate)
      if (!result.ok) {
        const hint = ERROR_HINTS[result.error] ?? ERROR_HINTS.fetch_failed
        return { data: hint(input.url), isError: true }
      }

      let host = 'site'
      try {
        host = new URL(result.sourceUrl).hostname.replace(/[^a-z0-9.-]/gi, '')
      } catch {
        // keep the fallback name
      }
      const stored = await deps.filesApi.writeBytes(
        {
          workspaceId: deps.workspaceId,
          userId: context.userId,
          assistantId: context.assistantId,
          assistantKind: context.assistantKind,
        },
        {
          path: `/doc/icons/${randomUUID()}-${host}.${result.ext}`,
          bytes: result.bytes,
          mime: result.mime,
          title: `Page icon (${host})`,
        },
      )
      if (!stored.ok) {
        // The bytes are in hand but the workspace-files write refused. Reuse
        // the files vocabulary rather than dumping `error.kind` at the model.
        return {
          data:
            `The icon was fetched from ${result.sourceUrl}, but storing it as a workspace file failed, so no icon token was produced and no page was changed. ` +
            `${workspaceFilesErrorMessage(stored.error)} ` +
            'Re-running fetchSiteIcon hits the same storage failure. Set an emoji icon instead with patchPage { op: "setIcon", icon: "<emoji>" }, and tell the user the real logo could not be saved.',
          isError: true,
        }
      }

      const icon = imageIconToken(deps.workspaceId, stored.value.id)
      return {
        data: {
          icon,
          sourceUrl: result.sourceUrl,
          mime: result.mime,
          sizeBytes: result.bytes.byteLength,
          nextStep:
            `Apply it with patchPage: { op: "setIcon", icon: "${icon}" } (or pass it as the icon argument of renderPage/createSubPage).`,
        },
      }
    },
  })
}
