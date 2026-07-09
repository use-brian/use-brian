/**
 * Outbound Slack mention resolution.
 *
 * Slack only notifies a user when the message carries `<@MEMBER_ID>` (a real
 * `U…`/`W…` id). Model-written text routinely carries the three broken forms
 * instead — `<@handle>` (handle inside id syntax, renders as literal
 * `<@awcjack>`), plain `@handle`, and plain `@Display Name` — none of which
 * notify anyone. This module rewrites those tokens against the workspace
 * member directory (`users.list`) at send time, so every adapter caller
 * (workflow delivery, scheduled reminders, interactive replies) ships real
 * mentions without each author having to know member ids.
 *
 * Matching is deliberately conservative: a token is only rewritten when it
 * resolves to EXACTLY ONE member (by handle, display name, or real name,
 * case-insensitive with `._-` treated as spaces). Ambiguous or unknown names
 * are left as plain text — a wrong ping is worse than no ping. The one
 * unconditional cleanup: an unresolvable `<@name>` is stripped to `@name`,
 * because the literal `<@name>` renders as line noise.
 *
 * Best-effort by contract: the resolver never throws (a directory fetch
 * failure returns the text unchanged), and the directory is TTL-cached per
 * bot token so chunked sends don't refetch.
 *
 * Spec: docs/architecture/channels/adapter-pattern.md → "Outbound mention
 * resolution". [COMP:channels/slack-mentions]
 */

export type SlackMember = {
  id: string
  /** The account handle (`name` in users.list — what `@handle` autocompletes). */
  handle: string
  displayName: string
  realName: string
}

/** A token that is already a real member/user-group id — never rewritten. */
const MENTION_ID_SHAPE = /^[UW][A-Z0-9]{2,}$/

/** `<@…>` tokens, with optional `|label` tail (Slack's escaped-mention form). */
const BRACKET_MENTION = /<@([^>|]+)(\|[^>]*)?>/g

/** A `<@…>` token whose inner part is NOT already a real id (needs work). */
const BRACKET_NEEDS_RESOLUTION = /<@(?![UW][A-Z0-9]{2,}[|>])[^>|]+(\|[^>]*)?>/

/**
 * Plain `@name` tokens: start-of-line or preceded by whitespace/`(`/`>`, then
 * `@` and a word-ish run (dots/hyphens/underscores allowed — `@hinson.wong`).
 * The preceding-boundary requirement keeps emails (`a@b.com`) untouched.
 */
const PLAIN_MENTION = /(^|[\s(>])@([A-Za-z0-9][A-Za-z0-9._-]{0,79})/g

/**
 * Slack broadcast keywords — NEVER resolved or rewritten. Converting a plain
 * `@here` into a real broadcast (`<!here>`) would let any model output mass-
 * ping a channel; leaving it as text is the safe behavior. Also excluded from
 * the candidate gate so routine chat text doesn't trigger directory fetches.
 */
const RESERVED_HANDLES = new Set(['here', 'channel', 'everyone'])

/** Normalize a name for lookup: lowercase, `._-` → space, collapse runs. */
function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Build the lookup index: normalized name form → member id, with ambiguous
 * forms (two members sharing a name) mapped to null so they are never used.
 */
export function buildMentionIndex(members: SlackMember[]): Map<string, string | null> {
  const index = new Map<string, string | null>()
  for (const m of members) {
    const forms = new Set<string>()
    for (const raw of [m.handle, m.displayName, m.realName]) {
      const norm = normalizeName(raw)
      if (norm) forms.add(norm)
    }
    for (const form of forms) {
      index.set(form, index.has(form) && index.get(form) !== m.id ? null : m.id)
    }
  }
  return index
}

function lookup(index: Map<string, string | null>, raw: string): string | null {
  return index.get(normalizeName(raw)) ?? null
}

/**
 * True when the text carries a token the resolver would actually act on — an
 * un-resolved `<@name>`, or a plain `@name` that is not a broadcast keyword.
 * Already-valid `<@U…>` mentions and `@here`/`@channel`/`@everyone` do NOT
 * count, so routine sends never trigger a directory fetch.
 */
export function hasMentionCandidates(text: string): boolean {
  if (BRACKET_NEEDS_RESOLUTION.test(text)) return true
  PLAIN_MENTION.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PLAIN_MENTION.exec(text)) !== null) {
    const core = m[2].replace(/[._-]+$/, '').toLowerCase()
    if (core && !RESERVED_HANDLES.has(core)) return true
  }
  return false
}

/**
 * Rewrite mention-shaped tokens in `text` against the member directory.
 * Pure — the caller supplies the members (see `resolveMentionsCached` for
 * the fetching/caching wrapper the adapter uses).
 */
export function resolveMentionsInText(text: string, members: SlackMember[]): string {
  const index = buildMentionIndex(members)

  // `<@X>` / `<@X|label>` — keep real ids, resolve names, strip failures.
  let out = text.replace(BRACKET_MENTION, (whole, inner: string, label: string | undefined) => {
    if (MENTION_ID_SHAPE.test(inner)) return whole
    const id = lookup(index, inner) ?? (label ? lookup(index, label.slice(1)) : null)
    if (id) return `<@${id}>`
    // Unresolvable: `<@awcjack>` renders as literal line noise — degrade to
    // plain text so the message at least reads cleanly.
    return `@${inner}`
  })

  // Plain `@name` — rewrite only on a unique directory match; otherwise the
  // token is probably prose (or an unknown person) and stays as typed.
  // Trailing `.`/`_`/`-` runs belong to the sentence, not the name
  // (`ping @tom.`) — split them off before the lookup, keep them after the
  // rewritten mention.
  out = out.replace(PLAIN_MENTION, (whole, lead: string, name: string) => {
    const core = name.replace(/[._-]+$/, '')
    const tail = name.slice(core.length)
    if (!core || RESERVED_HANDLES.has(core.toLowerCase())) return whole
    const id = lookup(index, core)
    return id ? `${lead}<@${id}>${tail}` : whole
  })

  return out
}

// ── Directory cache (per bot token) ────────────────────────────────────────

const DIRECTORY_TTL_MS = 5 * 60 * 1000
const DIRECTORY_CACHE_MAX = 50
const directoryCache = new Map<string, { at: number; members: SlackMember[] }>()

/** Test hook — clears the per-token directory cache. */
export function clearMentionDirectoryCache(): void {
  directoryCache.clear()
}

/**
 * Resolve mentions with a TTL-cached directory fetch. Never throws: any
 * directory failure (missing scope, network) returns the text with only the
 * dependency-free cleanup applied (unresolvable `<@name>` → `@name`).
 */
export async function resolveMentionsCached(
  text: string,
  cacheKey: string,
  fetchMembers: () => Promise<SlackMember[]>,
): Promise<string> {
  if (!hasMentionCandidates(text)) return text
  try {
    let entry = directoryCache.get(cacheKey)
    if (!entry || Date.now() - entry.at > DIRECTORY_TTL_MS) {
      const members = await fetchMembers()
      entry = { at: Date.now(), members }
      if (directoryCache.size >= DIRECTORY_CACHE_MAX) {
        const oldest = directoryCache.keys().next().value
        if (oldest !== undefined) directoryCache.delete(oldest)
      }
      directoryCache.set(cacheKey, entry)
    }
    return resolveMentionsInText(text, entry.members)
  } catch {
    // Directory unavailable — apply only the no-directory cleanup so a
    // literal `<@name>` never ships.
    return resolveMentionsInText(text, [])
  }
}
