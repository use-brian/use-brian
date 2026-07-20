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
import { buildTool, type FilesApi, type Tool } from '@use-brian/core'
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

const ERROR_HINTS: Record<string, string> = {
  invalid_url:
    'That URL is not fetchable (malformed, non-http, or a private address). Pass a public domain or image URL.',
  fetch_failed:
    'The site did not respond (or kept redirecting). Check the domain, or pass a direct image URL instead.',
  no_icon_found:
    'The site answered but exposed no usable icon (no apple-touch-icon / favicon / og:image in an accepted image format). Pass a direct image URL, or fall back to an emoji via patchPage setIcon.',
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
        return { data: ERROR_HINTS[result.error] ?? ERROR_HINTS.fetch_failed, isError: true }
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
        return {
          data: `Fetched the icon but could not store it: ${stored.error.kind}. Fall back to an emoji via patchPage setIcon.`,
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
