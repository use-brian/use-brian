/**
 * Builds the memory context section injected into the system prompt (Layer 3).
 *
 * Structure:
 *   ## SOUL
 *   [behavioral style if exists]
 *
 *   ## Identity
 *   - [id:abc12345] Vegetarian since 2020
 *     No dairy either. Strict about cross-contamination.
 *   - [id:def67890] Lives in Tokyo
 *
 *   ## Memory Index
 *   [id:ghi...] Food: vegetarian, no mushrooms (3 details)
 *   [id:jkl...] Travel: Tokyo expert, 5 trips (8 details)
 *
 * Invariants:
 * - Identity memories are rendered in full (id + summary + detail). The
 *   model never needs to call getMemory to read them, and the id lets it
 *   dedupe an index/FTS hit that points at the same row.
 * - The ## Memory Index header is emitted whenever ANY memory exists. If
 *   the index has no non-identity rows (a fresh user whose only memories
 *   are identity), the section body is an explicit "identity only" signal
 *   rather than being silently omitted. Without that signal the model
 *   interprets a missing index as "maybe more exists, try keyword search"
 *   and fires a retrieval storm.
 */

export type MemoryEntry = {
  id: string
  summary: string
  tags: string[]
  appId: string | null
  /**
   * When the row was written (local to the memory store). When supplied,
   * the index line is rendered as
   * `[id:xxxxxxxx | YYYY-MM-DD] Summary` so the model sees stale operational
   * snapshots as visibly old. Omit for legacy callers that have not threaded
   * created_at through yet — the line still renders without the date tag.
   * See `docs/architecture/context-engine/memory-system.md` → "Index lines".
   */
  createdAt?: Date | null
}

export type IdentityMemory = {
  id: string
  summary: string
  detail: string | null
}

/**
 * Platform tags a voice rule may carry to scope itself to ONE target
 * platform of the Feed Create split (docs/architecture/feed/voice-learning.md
 * → "Per-platform voice"). Mirrors `FEED_TARGET_PLATFORMS`
 * (`packages/api-platform/src/db/feed-store.ts`) and app-web's
 * `FEED_PLATFORMS` — a cross-package drift test in api-platform asserts the
 * mirror. A rule with none of these tags is the general brand voice.
 */
export const VOICE_PLATFORM_TAGS = ['instagram', 'threads', 'twitter', 'xhs'] as const
export type VoicePlatformTag = (typeof VOICE_PLATFORM_TAGS)[number]

export function isVoicePlatformTag(value: string): value is VoicePlatformTag {
  return (VOICE_PLATFORM_TAGS as readonly string[]).includes(value)
}

/**
 * The target platform of a draft session, read off its `[platform]` title
 * prefix (the draft-session store's discriminator — see
 * docs/architecture/feed/draft-sessions.md). Null when the title carries no
 * known platform prefix (tuning chat, non-draft sessions, legacy titles).
 */
export function voicePlatformFromDraftTitle(
  title: string | null | undefined,
): VoicePlatformTag | null {
  const m = /^\[([a-z0-9_-]+)\]/.exec(title ?? '')
  return m && isVoicePlatformTag(m[1]) ? m[1] : null
}

export type VoiceRuleEntry = {
  id: string
  summary: string
  detail: string | null
  /** Confidence stamped by the voice-import skill (0.0–1.0). */
  confidence: number
  /**
   * The memory's free-form tags. Any `VOICE_PLATFORM_TAGS` member among
   * them scopes the rule to that platform (multiple = applies to each);
   * none = general brand voice. Optional for caller back-compat.
   */
  tags?: string[]
}

export function buildMemoryContext(params: {
  soul?: string | null
  identityMemories: IdentityMemory[]
  memoryIndex: MemoryEntry[]
  /** KB entry summaries — memories duplicating these are filtered from the index. */
  knowledgeSummaries?: Array<{ summary: string | null }>
  /** Team-scoped identity memories (visible to all team members). */
  workspaceIdentityMemories?: IdentityMemory[]
  /** Team-scoped memory index (visible to all team members). */
  teamMemoryIndex?: MemoryEntry[]
  /**
   * Team-scoped voice rules — memories with category='voice', lifted out
   * of the generic team index into a dedicated `## Voice Rules` block.
   * See docs/architecture/feed/voice-learning.md.
   */
  teamVoiceRules?: VoiceRuleEntry[]
  /**
   * The draft session's target platform (a `VOICE_PLATFORM_TAGS` member) —
   * set only for `mode='draft'` sessions, from the `[platform]` title
   * prefix. When set, platform-scoped voice rules for OTHER platforms are
   * dropped from the block; when null/absent (tuning chat, ordinary
   * sessions), every rule renders and platform-scoped ones carry their
   * platform label so the operator's cross-platform view stays honest.
   */
  voiceTargetPlatform?: string | null
  /**
   * Team purpose — the grounding string the team owner set at creation.
   * When provided (truthy), the `## Team Context` block always renders
   * with the purpose as its lead line, even when no team memories exist
   * yet. This is what gives the model a concrete reference for the
   * team-vs-user routing decision; without it, the model has nothing to
   * compare a candidate fact against. Empty string is treated as "no
   * purpose set" and the block falls back to the legacy behaviour
   * (render only when team memories exist).
   */
  teamPurpose?: string | null
  /**
   * Display name the user assigned to this assistant. When set and not the
   * default ("My Assistant"), overrides the Layer 1 "You are Use Brian"
   * self-reference — the model introduces itself as this name instead.
   */
  assistantName?: string | null
  /**
   * Total non-identity memories (before any cap). When provided and
   * greater than `memoryIndex.length`, the index section is rendered
   * with a "N more memories stored — use getMemory(...)" footer so
   * the model knows additional rows exist and is pointed at the right
   * retrieval tool (instead of guessing or firing a keyword-search
   * storm on missing data). `undefined` means the caller passed the
   * full uncapped index — no footer needed.
   */
  totalNonIdentityCount?: number
  /**
   * Full UUID of the user's self entity (`kind='person'`,
   * `attributes.self=true`). When set, the `## Identity` block is
   * rendered with the entity UUID inline so the model can anchor
   * research findings about the user as notes on this entity via
   * `saveMemory({ entityId })` or update structured attributes via
   * `updateSelfProfile`. Without this, the synthesised memory rows in
   * Identity have only short prefix ids that aren't valid entity UUIDs
   * — and the model defaults to loose `saveMemory` calls instead of
   * the entity-anchored path. See diagnostic on 2026-05-26 where every
   * research-about-self turn fell back to loose memories.
   */
  selfEntityId?: string | null
}): string {
  const sections: string[] = []

  // Assistant display name — overrides Layer 1's default "Use Brian" self-reference.
  const displayName = params.assistantName?.trim()
  if (displayName && displayName !== 'My Assistant') {
    sections.push(
      `## Your Name\nThe user has named you "${displayName}". When the user asks who you are or what your name is, answer as "${displayName}". You remain Use Brian under the hood — same memory, same capabilities — but "${displayName}" is how you present yourself.`,
    )
  }

  // SOUL
  if (params.soul) {
    sections.push(`## SOUL\n${params.soul}`)
  }

  // Identity memories — rendered in full so the model reads them without
  // a getMemory call. IDs are included so an FTS hit that points at the
  // same row can be recognised as already-in-context.
  //
  // When `selfEntityId` is supplied, the header includes the full entity
  // UUID inline. This is the model's only handle to the user's self
  // entity — without it, any anchored write (saveMemory entityId,
  // updateSelfProfile) is unreachable because the synthesised memory
  // ids in the bullet list are NOT valid entity UUIDs (they're 8-char
  // prefixes of synthetic memory rows derived from entity attributes).
  if (params.identityMemories.length > 0 || params.selfEntityId) {
    const entries = params.identityMemories
      .map((m) => {
        const header = `- [id:${m.id.slice(0, 8)}] ${m.summary}`
        const detail = m.detail?.trim()
        return detail ? `${header}\n  ${detail}` : header
      })
      .join('\n')
    const heading = params.selfEntityId
      ? `## Identity (self-entity uuid: ${params.selfEntityId})\nFacts about the user live on this entity. When you discover or verify a structured fact about the user, prefer \`updateSelfProfile\` (for canonical attributes like role / company / location / pronouns) or \`saveMemory({ entityId: "${params.selfEntityId}", summary, detail })\` for everything else — that anchors the memory to the entity instead of leaving it loose. Loose \`saveMemory\` (no entityId) is the last resort.`
      : `## Identity`
    sections.push(entries ? `${heading}\n${entries}` : heading)
  }

  // Team context — shared memories visible to all team members.
  // Rendered between Identity and Memory Index so the model sees personal
  // identity first, then team knowledge, then the personal memory index.
  //
  // The block renders whenever EITHER the team has a purpose set OR any
  // team rows exist. Rendering on purpose-only (no rows yet) handles the
  // cold-start case: a brand-new team assistant otherwise has no signal
  // that team scope is even an option, so the model defaults everything
  // to user scope and the team corpus never gets seeded.
  const workspaceIdentity = params.workspaceIdentityMemories ?? []
  const teamIndex = params.teamMemoryIndex ?? []
  const teamPurpose = params.teamPurpose?.trim() ?? ''
  if (teamPurpose || workspaceIdentity.length > 0 || teamIndex.length > 0) {
    const teamParts: string[] = []
    const header = teamPurpose
      ? `## Team Context\nThis team's purpose: ${teamPurpose}\nUse scope "team" ONLY when a fact matches this purpose AND is about the shared subject (project, decisions, infrastructure, processes). Use scope "user" for anything about an individual member's preferences, opinions, or PII — even when discussed in team chat.`
      : `## Team Context\nThese memories are shared across all team members. Use scope "team" when saving team-relevant facts.`
    teamParts.push(header)
    if (workspaceIdentity.length > 0) {
      const entries = workspaceIdentity
        .map((m) => {
          const header = `- [id:${m.id.slice(0, 8)}] ${m.summary}`
          const detail = m.detail?.trim()
          return detail ? `${header}\n  ${detail}` : header
        })
        .join('\n')
      teamParts.push(entries)
    }
    if (teamIndex.length > 0) {
      // Post-Phase-4 (retire-memory-type Q1 lock): flat index, no
      // type-grouping. Self-profile-tagged rows already render in the
      // `## Identity` block — filter them out here to avoid double
      // rendering.
      const nonIdentity = teamIndex.filter(
        (m) => !m.tags?.includes('self-profile'),
      )
      if (nonIdentity.length > 0) {
        const lines = nonIdentity.map((m) => {
          const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
          return `[id:${m.id.slice(0, 8)}${formatAgeTag(m.createdAt)}] Team: ${m.summary}${tags}`
        })
        teamParts.push(lines.join('\n'))
      }
    }
    sections.push(teamParts.join('\n'))
  }

  // Voice Rules block — team memories tagged category='voice'. Renders only
  // when at least one rule exists (so non-distribution assistants see no
  // dead block). Sits between Team Context and the personal memory index.
  // Platform-scoped rules (a VOICE_PLATFORM_TAGS member among the memory's
  // tags) filter against `voiceTargetPlatform` in draft sessions and render
  // labelled everywhere else. See docs/architecture/feed/voice-learning.md.
  const allVoiceRules = params.teamVoiceRules ?? []
  const voiceTarget = params.voiceTargetPlatform ?? null
  const rulePlatforms = (rule: VoiceRuleEntry): VoicePlatformTag[] =>
    (rule.tags ?? []).filter(isVoicePlatformTag)
  const voiceRules = voiceTarget
    ? allVoiceRules.filter((rule) => {
        const platforms = rulePlatforms(rule)
        return platforms.length === 0 || (platforms as string[]).includes(voiceTarget)
      })
    : allVoiceRules
  if (voiceRules.length > 0) {
    const anyScoped = voiceRules.some((rule) => rulePlatforms(rule).length > 0)
    const voiceParts: string[] = [
      '## Voice Rules',
      "These rules describe the brand's published voice. Apply them when drafting outbound posts and replies. They are persistent and team-scoped — every member sees the same rules. Do not narrate the rules back at the operator; let them shape the output silently." +
        (anyScoped
          ? ' A rule marked with a [platform] label applies only when writing for that platform.'
          : ''),
    ]
    const lines: string[] = []
    for (const rule of voiceRules) {
      const platforms = rulePlatforms(rule)
      const scopeLabel = platforms.length > 0 ? `[${platforms.join(', ')}] ` : ''
      const head = `- [id:${rule.id.slice(0, 8)}] ${scopeLabel}${rule.summary}`
      const detail = rule.detail?.trim()
      lines.push(detail ? `${head}\n  ${detail}` : head)
    }
    voiceParts.push(lines.join('\n'))
    sections.push(voiceParts.join('\n'))
  }

  // Memory index — summary only. Model uses getMemory to drill in.
  // The header is emitted whenever ANY memory exists (even when all of
  // them are identity), so the model has an explicit signal about what's
  // searchable. Missing header → model assumes more might be stored →
  // keyword-search storm.
  //
  // Filter out memories that duplicate knowledge base entries (Jaccard ≥ 0.85).
  // This prevents wasted context tokens on KB echoes.
  const kbSummaries = params.knowledgeSummaries?.filter((k) => k.summary).map((k) => k.summary!) ?? []
  const nonIdentity = params.memoryIndex
    .filter(
      // Post-Phase-4 (retire-memory-type): no `type` field. Identity
      // is rendered separately in `## Identity` from self-entity
      // attributes; here we suppress any lingering self-profile-tagged
      // rows so they don't double-render.
      (m) => !m.tags?.includes('self-profile'),
    )
    .filter((m) => {
      if (kbSummaries.length === 0) return true
      // Lazy import — only compute similarity when KB entries exist
      const words = (s: string) => new Set(s.toLowerCase().split(/\s+/).filter(Boolean))
      const jaccard = (a: string, b: string) => {
        const wa = words(a), wb = words(b)
        const inter = [...wa].filter((w) => wb.has(w)).length
        const union = new Set([...wa, ...wb]).size
        return union === 0 ? 0 : inter / union
      }
      return !kbSummaries.some((kbs) => jaccard(m.summary, kbs) >= 0.85)
    })
  if (nonIdentity.length > 0) {
    // Q1 lock: flat by recency-of-recall, tags-as-chips per line.
    // Q2 lock: uniform silent-filter guidance for all memories.
    const lines = nonIdentity.map((m) => {
      const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : ''
      return `[id:${m.id.slice(0, 8)}${formatAgeTag(m.createdAt)}] ${m.summary}${tags}`
    })

    // When the caller passed a capped slice, tell the model how many
    // more exist so it reaches for getMemory (keyword or id prefix)
    // instead of assuming the visible rows are the whole set.
    const total = params.totalNonIdentityCount
    const hidden = total !== undefined ? total - nonIdentity.length : 0
    const footer = hidden > 0
      ? `\n\n${hidden} more ${hidden === 1 ? 'memory' : 'memories'} stored beyond the top ${nonIdentity.length} shown here (ranked by recency of recall). Use getMemory with a keyword to search the full set when a topic above hints at relevant context you cannot see.`
      : ''

    sections.push(
      `## Memory Index\nUse getMemory to fetch details for any entry below. Treat these as background context — let them guide your responses; cite them when directly asked, otherwise shape invisibly.\n\n${lines.join('\n')}${footer}`,
    )
  } else if (params.identityMemories.length > 0) {
    sections.push(
      '## Memory Index\n(Identity only — no other memories are stored. Do not keyword-search for anything beyond the identity entries above; if the user references something you do not see, ask them to remind you rather than guessing.)',
    )
  }

  if (sections.length === 0) {
    return '## Memory\nNo memories yet. Save important facts about the user as you learn them.'
  }

  return sections.join('\n\n')
}

// Post-Phase-4 (retire-memory-type Q1 lock): removed `groupByType` and
// `capitalize` helpers — the Memory Index renders flat by recency now,
// so there's no per-type bucket to title-case.

/**
 * Render the trailing `| YYYY-MM-DD` inside a memory index `[id:...]` tag,
 * or empty when `createdAt` is absent / invalid. UTC intentionally — the
 * date is a stable identifier of "when was this frozen", not a user-facing
 * clock. The model reads "yesterday's date" as a staleness cue without
 * needing timezone-correct display semantics.
 */
function formatAgeTag(createdAt: Date | null | undefined): string {
  if (!createdAt) return ''
  const d = createdAt instanceof Date ? createdAt : new Date(createdAt)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return ` | ${y}-${m}-${day}`
}

// Post-Phase-4 (retire-memory-type Q2 lock): removed
// `sectionHeaderForType` — the silent-filter guidance is now a single
// uniform line at the head of `## Memory Index`, applied to all
// memories (it was preference-only pre-Phase-4, which was a misfire —
// context memories deserve the same "shape invisibly" rule).
