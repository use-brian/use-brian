/**
 * Page-icon value helpers — the one place that knows the shape of an
 * IMAGE page icon.
 *
 * `saved_views.icon` holds either:
 *   - an emoji grapheme (≤16 chars) — the historical value, or
 *   - an image token `img:<workspaceId>/<fileId>` — a workspace-files row
 *     (GCS-backed) fetched and stored by the `fetchSiteIcon` doc tool.
 *
 * The token carries the workspace id so every render site can build the
 * authenticated read URL (`GET /api/doc-files/:workspaceId/:fileId` →
 * 302 signed GCS URL) without threading a workspaceId prop through nine
 * component call sites. RLS on that route is the access control — a
 * token pasted across workspaces just fails to load and the renderer
 * falls back to the derived glyph.
 *
 * Shared by: core zod schemas (`views/schemas.ts`, `doc/page-schemas.ts`),
 * the api-side `fetchSiteIcon` tool (mints tokens), and the app-web
 * `PageIcon` renderer (parses them).
 *
 * Spec: docs/architecture/features/doc.md → "Image icons".
 */

const UUID_SRC =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export const ICON_IMAGE_PREFIX = 'img:'

/** Full-match test for an image icon token: `img:<workspaceId>/<fileId>`. */
export const IMAGE_ICON_RE = new RegExp(`^img:${UUID_SRC}/${UUID_SRC}$`, 'i')

export function isImageIcon(icon: string | null | undefined): icon is string {
  return typeof icon === 'string' && IMAGE_ICON_RE.test(icon)
}

/** Mint the icon column value for a stored image. */
export function imageIconToken(workspaceId: string, fileId: string): string {
  return `${ICON_IMAGE_PREFIX}${workspaceId}/${fileId}`
}

/** Parse an icon value into its image halves, or null for emoji/null/junk. */
export function parseImageIcon(
  icon: string | null | undefined,
): { workspaceId: string; fileId: string } | null {
  if (!isImageIcon(icon)) return null
  const [workspaceId, fileId] = icon.slice(ICON_IMAGE_PREFIX.length).split('/')
  return { workspaceId, fileId }
}
