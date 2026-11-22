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
 * Within each source scope, look for exact paths, relative paths and
 * basenames in the same order as the sync resolver.
 *
 * Spec: docs/architecture/features/knowledge-base.md → "Reader surface".
 */

import type { KnowledgeRelatedRef } from "@/lib/api/brain";

export const KB_WIKILINK_SCHEME = "kbwiki:";

export function knowledgeEntryHref(workspaceId: string, entryId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}/brain/entry/knowledge/${encodeURIComponent(entryId)}`;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const FENCE_RE = /^(```|~~~)/;

/** Collect link URLs from the same rewritten Markdown supplied to the reader. */
export function collectKnowledgeLinks(rewritten: string): string[] {
  let inFence = false;
  const links = new Set<string>();
  for (const line of rewritten.split("\n")) {
    if (FENCE_RE.test(line.trimStart())) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const link of line.matchAll(/\]\(<?([^\s)>]+)>?/g)) {
      if (readLinkTarget(link[1])) links.add(link[1]);
    }
  }
  return [...links];
}

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
function resolveRelative(target: string, basePath: string): string {
  const segments = basePath.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

function readLinkTarget(href: string): string | null {
  if (href.startsWith(KB_WIKILINK_SCHEME)) {
    try {
      return decodeURIComponent(href.slice(KB_WIKILINK_SCHEME.length));
    } catch {
      return null;
    }
  }
  return /\.md(#.*)?$/i.test(href) && !/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : null;
}

function pathCandidates(raw: string, currentPath: string): string[] {
  const target = normaliseTarget(raw);
  if (raw.startsWith("./") || raw.startsWith("../")) {
    // The sync resolver uses the normalized entry path as its base. Legacy
    // regular-file links also use the entry's parent directory.
    const parent = currentPath.split("/").slice(0, -1).join("/");
    return [resolveRelative(target, currentPath), resolveRelative(target, parent)];
  }
  return [target.replace(/^\/+/, "")];
}

/**
 * Map an intercepted href to a related entry. Returns null when the
 * target is external (`http…`), unresolvable, or above clearance.
 */
export function resolveWikilinkTarget(
  href: string,
  currentPath: string,
  related: KnowledgeRelatedRef[],
  currentSourceId?: string | null,
  entryLinks: string[] = [],
): KnowledgeRelatedRef | null {
  const raw = readLinkTarget(href);
  if (!raw) return null;
  const target = normaliseTarget(raw);
  if (!target) return null;

  const base = target.split("/").pop() ?? target;
  const lower = target.toLowerCase();
  const direct = pathCandidates(raw, currentPath);
  const matchers = direct.map(path => (ref: KnowledgeRelatedRef) => ref.path === path);
  if (!raw.startsWith("/") && !raw.startsWith(".") && !target.includes("/")) {
    matchers.push((ref) => (ref.path.split("/").pop() ?? ref.path) === base);
    matchers.push((ref) => ref.title.toLowerCase() === lower);
  }
  const groups = currentSourceId === undefined
    ? [related]
    : [related.filter((ref) => ref.sourceId === currentSourceId), related];
  for (const group of groups) {
    for (const [index, matches] of matchers.entries()) {
      const candidates = group.filter(matches);
      if (candidates.length === 0) continue;
      if (candidates.length > 1) return null;
      const [candidate] = candidates;
      // The related IDs do not record which reference produced each edge.
      // A fuzzy alias cannot borrow the edge already proven by a different
      // explicit link to the same entry.
      if (index >= direct.length && entryLinks.some(link => {
        const other = readLinkTarget(link);
        return other && normaliseTarget(other) !== target && pathCandidates(other, currentPath).includes(candidate.path);
      })) return null;
      return candidate;
    }
  }
  return null;
}
