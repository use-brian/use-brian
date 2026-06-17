import { describe, it, expect } from 'vitest'
import { buildMemoryContext } from '../context-builder.js'

// Pattern-extractor tests retired (Q9, 2026-05-28): the regex
// `extractPatterns` matcher was deleted along with the file
// `pattern-extractor.ts`. Chat-side facts now flow through the chat-
// compaction Episode → Pipeline B path instead of a parallel regex
// pre-filter.

describe('[COMP:memory/context-builder] Memory context builder', () => {
  it('builds context with all sections', () => {
    const ctx = buildMemoryContext({
      soul: 'Casual tone, brief responses.',
      identityMemories: [
        { id: 'id1abcde', summary: 'User is a software engineer', detail: 'Works at Google since 2020' },
        { id: 'id2abcde', summary: 'User lives in Tokyo', detail: null },
      ],
      memoryIndex: [
        { id: 'id1abcde', summary: 'User is a software engineer', tags: [], appId: null },
        { id: 'id3abcde', summary: 'Vegetarian, no spicy food', tags: ['food'], appId: null },
        { id: 'id4abcde', summary: 'Planning Tokyo trip March 2026', tags: ['travel'], appId: null },
      ],
    })

    expect(ctx).toContain('## SOUL')
    expect(ctx).toContain('Casual tone')
    expect(ctx).toContain('## Identity')
    expect(ctx).toContain('software engineer')
    expect(ctx).toContain('## Memory Index')
    expect(ctx).toContain('Vegetarian')
    expect(ctx).toContain('getMemory')
  })

  it('renders identity entries with id prefix and detail', () => {
    const ctx = buildMemoryContext({
      identityMemories: [
        { id: 'neal1234', summary: 'Neal is a legend', detail: 'neal = legend' },
        { id: 'jack5678', summary: "Jackal's nickname", detail: null },
      ],
      memoryIndex: [
        { id: 'neal1234', summary: 'Neal is a legend', tags: [], appId: null },
        { id: 'jack5678', summary: "Jackal's nickname", tags: [], appId: null },
      ],
    })

    // ID prefix present so FTS hits can be deduped against in-context identity
    expect(ctx).toContain('[id:neal1234]')
    expect(ctx).toContain('[id:jack5678]')
    // Detail rendered when present
    expect(ctx).toContain('neal = legend')
    // Null detail is omitted cleanly (no trailing whitespace line)
    expect(ctx).not.toMatch(/Jackal's nickname\n\s+null/)
    expect(ctx).not.toMatch(/Jackal's nickname\n {2}$/m)
  })

  it('emits an identity-only Memory Index signal when only self-profile rows exist', () => {
    // Post-Phase-4 (retire-memory-type): the index excludes
    // self-profile-tagged rows (they render in `## Identity` instead).
    // When ONLY those exist alongside identity memories, the Memory
    // Index should still emit the "Identity only" signal to suppress
    // speculative keyword search.
    const ctx = buildMemoryContext({
      identityMemories: [
        { id: 'neal1234', summary: 'Neal is a legend', detail: 'neal = legend' },
        { id: 'jack5678', summary: "Jackal's nickname", detail: 'Jackal is known as 光頭仔' },
      ],
      memoryIndex: [
        { id: 'neal1234', summary: 'Neal is a legend', tags: ['self-profile'], appId: null },
        { id: 'jack5678', summary: "Jackal's nickname", tags: ['self-profile'], appId: null },
      ],
    })

    expect(ctx).toContain('## Memory Index')
    expect(ctx).toContain('Identity only')
    expect(ctx).toContain('Do not keyword-search')
  })

  it('renders the self-entity UUID inline when selfEntityId is provided', () => {
    // The model needs the full entity UUID to anchor research findings
    // via saveMemory({ entityId }) or updateSelfProfile. Without it, the
    // synthesised memory ids in the Identity bullets are not valid entity
    // UUIDs — the entity-anchored write path is structurally unreachable.
    const selfEntityId = '3bffbd92-2c4f-4f15-8571-09f780aaed68'
    const ctx = buildMemoryContext({
      identityMemories: [
        { id: 'hinsxxxx', summary: 'User: Hinson Wong', detail: null },
      ],
      memoryIndex: [],
      selfEntityId,
    })
    expect(ctx).toContain('## Identity')
    expect(ctx).toContain(selfEntityId)
    expect(ctx).toContain('updateSelfProfile')
    expect(ctx).toContain('saveMemory({ entityId:')
  })

  it('still renders the Identity header with the UUID even when no identity memories exist', () => {
    // A user with a freshly-created self entity (only `self: true`) has
    // no synthesised identity rows. The header should still emit so the
    // model knows where to anchor the first attribute write.
    const selfEntityId = '11111111-2222-3333-4444-555555555555'
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      selfEntityId,
    })
    expect(ctx).toContain('## Identity')
    expect(ctx).toContain(selfEntityId)
  })

  it('does NOT render an Identity heading when selfEntityId is absent and identityMemories is empty', () => {
    // Backwards-compat: callers that haven't plumbed selfEntityId yet
    // (or have nothing to render) shouldn't get an empty Identity header.
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
    })
    expect(ctx).not.toContain('## Identity')
  })

  it('handles empty memory', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
    })
    expect(ctx).toContain('No memories yet')
    // And no spurious identity-only signal when there is literally nothing
    expect(ctx).not.toContain('## Memory Index')
  })

  it('renders the index flat (post-Phase-4 retire-memory-type Q1 lock)', () => {
    // Post-Phase-4: no per-type grouping; flat list by recency, tags
    // as chips on each line.
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        { id: 'a1234567', summary: 'Likes sushi', tags: [], appId: null },
        { id: 'b1234567', summary: 'Hates spicy', tags: [], appId: null },
        { id: 'c1234567', summary: 'Trip to Tokyo', tags: [], appId: null },
      ],
    })
    // No per-type headers
    expect(ctx).not.toContain('### Preferences')
    expect(ctx).not.toContain('### Context')
    // All entries present, flat
    expect(ctx).toContain('[id:a1234567] Likes sushi')
    expect(ctx).toContain('[id:b1234567] Hates spicy')
    expect(ctx).toContain('[id:c1234567] Trip to Tokyo')
  })

  it('emits uniform silent-filter guidance for all memories (post-Phase-4 Q2 lock)', () => {
    // Post-Phase-4: the silent-filter line applies to all memories,
    // not just preferences. One sentence at the head of `## Memory
    // Index`.
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        { id: 'abcd1234', summary: 'User dislikes eggs', tags: [], appId: null },
      ],
    })
    expect(ctx).toContain('background context')
    expect(ctx).toContain('shape invisibly')
    expect(ctx).toContain('[id:abcd1234] User dislikes eggs')
  })

  it('renders mixed memory tags in the flat index (post-Phase-4 retire-memory-type)', () => {
    // Post-Phase-4: no preference/context ordering. REM outputs ride
    // on `consolidation:rem` tag and surface flat with other rows.
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        { id: 'z1234567', summary: 'REM pattern about Brian', tags: ['consolidation:rem'], appId: null },
        { id: 'a1234567', summary: 'Likes sushi', tags: [], appId: null },
        { id: 'm1234567', summary: 'Trip to Tokyo', tags: [], appId: null },
      ],
    })
    // No per-section headers post-Phase-4.
    expect(ctx).not.toContain('### Preferences')
    expect(ctx).not.toContain('### Context')
    expect(ctx).not.toContain('### Connections')
    // All three rows surface in the flat index.
    expect(ctx).toContain('REM pattern about Brian')
    expect(ctx).toContain('Likes sushi')
    expect(ctx).toContain('Trip to Tokyo')
  })

  it('appends a "N more memories stored" footer when totalNonIdentityCount exceeds the rendered slice', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        { id: 'a1234567', summary: 'Likes sushi', tags: [], appId: null },
        { id: 'b1234567', summary: 'Hates spicy', tags: [], appId: null },
      ],
      totalNonIdentityCount: 42,
    })
    // Rendered rows still visible (under the ### Preferences header).
    expect(ctx).toContain('[id:a1234567] Likes sushi')
    // Footer signals how many are hidden (42 total − 2 rendered = 40).
    expect(ctx).toContain('40 more memories stored')
    // Footer points the model at the right retrieval tool instead of
    // letting it guess (the retrieval-storm guard).
    expect(ctx).toContain('Use getMemory')
  })

  it('uses singular "memory" when exactly one row is hidden beyond the rendered slice', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        { id: 'a1234567', summary: 'Likes sushi', tags: [], appId: null },
        { id: 'b1234567', summary: 'Hates spicy', tags: [], appId: null },
      ],
      totalNonIdentityCount: 3,
    })
    expect(ctx).toContain('1 more memory stored')
    expect(ctx).not.toContain('1 more memories')
  })

  it('does NOT append the footer when totalNonIdentityCount equals the rendered slice', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        { id: 'a1234567', summary: 'Likes sushi', tags: [], appId: null },
        { id: 'b1234567', summary: 'Hates spicy', tags: [], appId: null },
      ],
      totalNonIdentityCount: 2,
    })
    expect(ctx).not.toContain('more memories stored')
    expect(ctx).not.toContain('more memory stored')
  })

  it('does NOT append the footer when totalNonIdentityCount is undefined (uncapped callers)', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        { id: 'a1234567', summary: 'Likes sushi', tags: [], appId: null },
      ],
    })
    expect(ctx).not.toContain('more memories stored')
    expect(ctx).not.toContain('more memory stored')
  })

  // ── Team Context block (post-053 purpose-driven rendering) ──────

  it('renders Team Context with purpose even when no team memories exist (cold-start)', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamPurpose: 'Backend platform team — runs the order pipeline and Postgres infra.',
    })
    expect(ctx).toContain('## Team Context')
    expect(ctx).toContain("This team's purpose: Backend platform team")
    // The sharpened nudge — keep team scope tight to the shared subject.
    expect(ctx).toContain('about the shared subject')
    expect(ctx).toContain('individual member')
  })

  it('still renders Team Context with the legacy header when purpose is empty but team rows exist', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamPurpose: '',
      workspaceIdentityMemories: [
        { id: 'team1aaa', summary: 'We use Postgres 16', detail: null },
      ],
    })
    expect(ctx).toContain('## Team Context')
    expect(ctx).toContain('shared across all team members')
    // Legacy header — no purpose line.
    expect(ctx).not.toContain("This team's purpose:")
  })

  it('does NOT render Team Context when there is neither purpose nor team rows', () => {
    const ctx = buildMemoryContext({
      identityMemories: [
        { id: 'me111111', summary: 'Vegetarian', detail: null },
      ],
      memoryIndex: [
        { id: 'me111111', summary: 'Vegetarian', tags: [], appId: null },
      ],
    })
    expect(ctx).not.toContain('## Team Context')
  })

  it('renders purpose-led header AND existing team rows together', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [],
      teamPurpose: 'Q2 onboarding redesign',
      workspaceIdentityMemories: [
        { id: 'team2aaa', summary: 'Designer-led, ships May 1', detail: null },
      ],
      teamMemoryIndex: [
        { id: 'team3aaa', summary: 'Figma file FX-42', tags: ['design'], appId: null },
      ],
    })
    expect(ctx).toContain('## Team Context')
    expect(ctx).toContain('Q2 onboarding redesign')
    expect(ctx).toContain('Designer-led, ships May 1')
    // Post-Phase-4 (retire-memory-type): no per-type "Team Context:"
    // prefix; flat "Team: " prefix for all team memory index rows.
    expect(ctx).toContain('Team: Figma file FX-42')
  })

  // ── Staleness tag on index lines ───────────────────────────
  // See `docs/architecture/context-engine/memory-system.md` →
  // "Index line format". Context-type memory lines carry the write
  // date so the model sees yesterday's "30m overdue" snapshot as
  // visibly stale rather than pattern-matching it onto today's clock.
  // Motivation: 2026-04-23 Cynthia incident.
  it('renders `| YYYY-MM-DD` staleness tag on index lines when createdAt is supplied', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        {
          id: 'op111111',

          summary: 'Pill reminder fired at 14:30 HKT',
          tags: [],
          appId: null,
          createdAt: new Date('2026-04-22T06:00:00Z'),
        },
      ],
    })
    expect(ctx).toContain('[id:op111111 | 2026-04-22]')
  })

  it('omits the staleness tag when createdAt is undefined (legacy callers)', () => {
    const ctx = buildMemoryContext({
      identityMemories: [],
      memoryIndex: [
        {
          id: 'op222222',

          summary: 'Pill reminder fired at 14:30 HKT',
          tags: [],
          appId: null,
        },
      ],
    })
    expect(ctx).toContain('[id:op222222]')
    expect(ctx).not.toContain('| 20')
  })
})
