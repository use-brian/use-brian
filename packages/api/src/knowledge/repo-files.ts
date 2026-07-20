/**
 * Pure repo-file helpers shared by the knowledge edit-proposal routes and
 * the assistant repo writer. Extracted from `routes/knowledge.ts` (which
 * re-exports them for compatibility).
 */

import { normalisePath } from '@use-brian/core'

/**
 * Split a raw markdown file into its verbatim frontmatter block (including
 * both `---` fences and the trailing newline) and the body. The DB stores
 * the frontmatter-STRIPPED body, so a proposal splices the edited body
 * under the file's existing frontmatter byte-for-byte — sensitivity, tags,
 * and any custom metadata survive an edit untouched.
 */
export function splitFrontmatterBlock(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/)
  if (!match) return { frontmatter: '', body: raw }
  return { frontmatter: match[0], body: raw.slice(match[0].length) }
}

/**
 * Locate the repo file backing an entry path. `normalisePath` strips both
 * `.md` and a trailing `/index`, so `products/vault` may live at
 * `products/vault.md` OR `products/vault/index.md` — the only reliable
 * mapping is probing the actual tree: pick the `.md` blob under
 * `rootPath` whose normalised relative path equals the entry path.
 */
export function resolveRepoFilePath(
  treePaths: string[],
  rootPath: string,
  entryPath: string,
): string | null {
  const prefix = rootPath.replace(/\/+$/, '')
  for (const p of treePaths) {
    if (!p.endsWith('.md')) continue
    if (prefix && !p.startsWith(prefix)) continue
    const relative = prefix ? p.slice(prefix.length).replace(/^\//, '') : p
    if (normalisePath(relative) === entryPath) return p
  }
  return null
}
