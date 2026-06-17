// [COMP:app-web/kb-wikilinks]
/**
 * Wikilink rewrite + client-side resolution for the knowledge entry
 * reader. KB markdown carries Obsidian-style `[[target|alias]]` links
 * and relative `[text](../foo.md)` links; react-markdown renders
 * neither as an in-app navigation. This module:
 *
 *   1. `rewriteWikilinks(content)` — turns `[[target|alias]]` into a
 *      standard markdown link with the `kbwiki:` scheme so the renderer
 *      emits an `<a>` the reader's link component can intercept. Fenced
 *      code blocks are left untouched.
 *   2. `resolveWikilinkTarget(href, currentPath, related)` — maps an
 *      intercepted href (a `kbwiki:` target OR a relative `.md` link)
 *      to one of the entry's resolved `related` refs. The sync worker
 *      already resolved every body wikilink into `related_ids`, so the
 *      related list is the complete resolution universe — anything not
 *      in it is genuinely unresolvable for this viewer (broken link, or
 *      a target above their clearance) and renders as plain text.
 *
 * Mirrors the server resolver's order (exact path → relative → basename;
 * see packages/core/src/knowledge/wikilink-resolver.ts) without
 * re-shipping the path index — the related list is tiny.
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Reader surface".
 */

import type { KnowledgeRelatedRef } from "@/lib/api/brain";

export const KB_WIKILINK_SCHEME = "kbwiki:";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const FENCE_RE = /^(```|~~~)/;

/** `[[products/vault|Vault]]` → `[Vault](kbwiki:products%2Fvault)`. */
export function rewriteWikilinks(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (FENCE_RE.test(line.trimStart())) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(WIKILINK_RE, (_match, inner: string) => {
        const [target, alias] = inner.split("|").map((s) => s.trim());
        if (!target) return _match;
        const label = alias && alias.length > 0 ? alias : target;
        return `[${label}](${KB_WIKILINK_SCHEME}${encodeURIComponent(target)})`;
      });
    })
    .join("\n");
}

/** Normalise a raw link target the way the KB path scheme does: strip
 *  `.md`, anchors, leading `./`, trailing `/index`. */
function normaliseTarget(raw: string): string {
  return raw
    .replace(/#.*$/, "")
    .replace(/\.md$/i, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/\/index$/i, "");
}

/** Resolve `..` / `.` segments of `target` against the directory of
 *  `currentPath` (an entry path like `products/vault`). */
function resolveRelative(target: string, currentPath: string): string {
  const baseSegments = currentPath.split("/").slice(0, -1);
  const segments = [...baseSegments];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

/**
 * Map an intercepted href to a related entry. Returns null when the
 * target is external (`http…`), unresolvable, or above clearance.
 */
export function resolveWikilinkTarget(
  href: string,
  currentPath: string,
  related: KnowledgeRelatedRef[],
): KnowledgeRelatedRef | null {
  let raw: string;
  if (href.startsWith(KB_WIKILINK_SCHEME)) {
    raw = decodeURIComponent(href.slice(KB_WIKILINK_SCHEME.length));
  } else if (/\.md(#.*)?$/i.test(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    raw = href;
  } else {
    return null;
  }

  const target = normaliseTarget(raw);
  if (target.length === 0) return null;

  // 1. Exact path match.
  const exact = related.find((r) => r.path === target);
  if (exact) return exact;

  // 2. Relative to the current entry's directory.
  if (target.includes("..") || raw.startsWith("./") || !target.includes("/")) {
    const resolved = resolveRelative(target, currentPath);
    const rel = related.find((r) => r.path === resolved);
    if (rel) return rel;
  }

  // 3. Basename match (`[[vault-spec]]` against `products/vault-spec`).
  const base = target.split("/").pop() ?? target;
  const byBase = related.find((r) => (r.path.split("/").pop() ?? r.path) === base);
  if (byBase) return byBase;

  // 4. Title match — frontmatter `related:` entries sometimes name the
  //    doc title rather than its path.
  const lower = target.toLowerCase();
  return related.find((r) => r.title.toLowerCase() === lower) ?? null;
}
