import { describe, it, expect } from 'vitest'
import { appAssistantForbidsResearch, appAssistantForbidsCoordinator, isAdaptiveResearchEligible, isUserBlocked, sanitizeTitle, buildActivePageInstruction, buildViewingSkillBlock, buildViewingDeckBlock, resolveStickyChannelId, isDocSurface, isAppSurface, attachTurnContext } from '../chat.js'
import type { Message } from '@use-brian/core'

describe('[COMP:api/chat-route] sanitizeTitle', () => {
  it('strips bold markdown', () => {
    expect(sanitizeTitle('This Friday, **April 10, 2026**, events')).toBe(
      'This Friday, April 10, 2026, events',
    )
  })

  it('strips italic markdown (both star and underscore variants)', () => {
    expect(sanitizeTitle('*Weekend* plans with _friends_')).toBe('Weekend plans with friends')
  })

  it('strips inline code and leading heading', () => {
    expect(sanitizeTitle('## `build` pipeline notes')).toBe('build pipeline notes')
  })

  it('strips enclosing double and single quotes', () => {
    expect(sanitizeTitle('"Friday plans"')).toBe('Friday plans')
    expect(sanitizeTitle("'Friday plans'")).toBe('Friday plans')
  })

  it('strips trailing punctuation', () => {
    expect(sanitizeTitle('Friday plans!')).toBe('Friday plans')
    expect(sanitizeTitle('Friday plans?')).toBe('Friday plans')
    expect(sanitizeTitle('Friday plans.')).toBe('Friday plans')
  })

  it('takes only the first line when the model emits a title + explanation', () => {
    const raw = 'Friday dinner plans\n\nThis title summarises the user asking about...'
    expect(sanitizeTitle(raw)).toBe('Friday dinner plans')
  })

  it('trims to the last whole word within the max length', () => {
    const raw = 'This Friday there are several notable events and also happenings'
    const out = sanitizeTitle(raw, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    // The output must be a prefix of the input, cut at a word boundary —
    // i.e. the character immediately after the output in the input (if any)
    // must be a space.
    expect(raw.startsWith(out)).toBe(true)
    const nextChar = raw.charAt(out.length)
    expect(nextChar === '' || nextChar === ' ').toBe(true)
  })

  it('regression: the exact broken title from the bug report is cleaned up', () => {
    // From the screenshot: "This Friday, **April 10, 2026**, there are several notable e"
    // The markdown must be stripped AND the output must end on a word boundary.
    const raw = 'This Friday, **April 10, 2026**, there are several notable events happening'
    const out = sanitizeTitle(raw)
    expect(out).not.toContain('**')
    expect(out).not.toMatch(/\se$/) // no truncated "e" at end
    expect(out.length).toBeLessThanOrEqual(48)
  })

  it('returns an empty string for pure whitespace', () => {
    expect(sanitizeTitle('   \n\n   ')).toBe('')
  })

  it('passes short clean titles through unchanged', () => {
    expect(sanitizeTitle('Friday dinner with Neal')).toBe('Friday dinner with Neal')
  })

  it('handles non-English content (Cantonese title)', () => {
    expect(sanitizeTitle('星期五同朋友食飯')).toBe('星期五同朋友食飯')
  })
})

describe('[COMP:brain/assistant-blocklist-evaluator] isUserBlocked', () => {
  const userA = '11111111-1111-1111-1111-111111111111'
  const userB = '22222222-2222-2222-2222-222222222222'
  const userC = '33333333-3333-3333-3333-333333333333'

  it('returns false for an empty blocklist', () => {
    expect(isUserBlocked([], userA)).toBe(false)
  })

  it('returns false when the blocklist is null (defensive — column is NOT NULL in DB)', () => {
    expect(isUserBlocked(null, userA)).toBe(false)
  })

  it('returns false when the blocklist is undefined (defensive — column is NOT NULL in DB)', () => {
    expect(isUserBlocked(undefined, userA)).toBe(false)
  })

  it('returns true when the user is the sole entry in the blocklist', () => {
    expect(isUserBlocked([userA], userA)).toBe(true)
  })

  it('returns false when the user is absent from a non-empty blocklist', () => {
    expect(isUserBlocked([userB, userC], userA)).toBe(false)
  })

  it('returns true when the user is one of several entries', () => {
    expect(isUserBlocked([userB, userA, userC], userA)).toBe(true)
  })
})

describe('[COMP:api/chat-route] isAdaptiveResearchEligible', () => {
  // Baseline: a paid, workspace-scoped, non-app assistant with an
  // unpinned mode — the case adaptive entry is for. (Message presence
  // is guarded at the call site, not in this policy predicate.)
  const base = {
    requestedMode: undefined as 'default' | 'research' | undefined,
    workspaceId: 'ws-1',
    userPlan: 'pro',
    assistantKind: 'standard' as string | null | undefined,
  }

  it('is eligible for a paid, workspace-scoped, non-app assistant with an unpinned mode', () => {
    expect(isAdaptiveResearchEligible(base)).toBe(true)
  })

  it('treats a primary assistant the same as standard (eligible)', () => {
    expect(isAdaptiveResearchEligible({ ...base, assistantKind: 'primary' })).toBe(true)
  })

  it("regression: kind='app' (doc/feed) is NEVER adaptively eligible", () => {
    // The bug: a doc assistant got auto-upgraded into research mode,
    // which strips renderPage/renderView and breaks page authoring.
    expect(isAdaptiveResearchEligible({ ...base, assistantKind: 'app' })).toBe(false)
  })

  it("does not run adaptively when the caller pinned mode: 'research' (manual entry)", () => {
    expect(isAdaptiveResearchEligible({ ...base, requestedMode: 'research' })).toBe(false)
  })

  it("does not run adaptively when the caller pinned mode: 'default' (explicit opt-out)", () => {
    expect(isAdaptiveResearchEligible({ ...base, requestedMode: 'default' })).toBe(false)
  })

  it('is not eligible on the free plan', () => {
    expect(isAdaptiveResearchEligible({ ...base, userPlan: 'free' })).toBe(false)
  })

  it('is not eligible without a workspace (research requires workspace billing)', () => {
    expect(isAdaptiveResearchEligible({ ...base, workspaceId: null })).toBe(false)
    expect(isAdaptiveResearchEligible({ ...base, workspaceId: undefined })).toBe(false)
  })
})

describe('[COMP:api/chat-route] appAssistantForbidsResearch', () => {
  // Governs the EXPLICIT mode:'research' toggle force-off. Only `kind='app'`
  // assistants remain (feed/distribution) and they forbid research. Doc is no
  // longer an app type — doc research runs on the host assistant (the primary
  // by default), which is not kind='app', so it is allowed.
  it('forbids research for ALL app assistants (only feed remains)', () => {
    expect(appAssistantForbidsResearch('app')).toBe(true)
  })

  it('allows research for standard and primary assistants', () => {
    expect(appAssistantForbidsResearch('standard')).toBe(false)
    expect(appAssistantForbidsResearch('primary')).toBe(false)
  })

  it('does not forbid on null/undefined kind (non-app default)', () => {
    expect(appAssistantForbidsResearch(null)).toBe(false)
    expect(appAssistantForbidsResearch(undefined)).toBe(false)
  })
})

describe('[COMP:api/chat-route] appAssistantForbidsCoordinator', () => {
  // Closes the coordinator triggers — the explicit mode:'research' toggle AND
  // the Pro/Max splitter — for ALL `kind='app'` assistants (only feed remains).
  // Coordinator mode strips authoring/execution tools. Doc-surface turns are
  // also kept out of coordinator mode (via the !onDocSurface guard in the
  // route), so a primary authoring on doc stays page-authoring.
  it("forbids coordinator for kind='app'", () => {
    expect(appAssistantForbidsCoordinator('app')).toBe(true)
  })

  it('allows coordinator for standard and primary assistants', () => {
    expect(appAssistantForbidsCoordinator('standard')).toBe(false)
    expect(appAssistantForbidsCoordinator('primary')).toBe(false)
  })

  it('does not forbid on null/undefined kind (non-app default)', () => {
    expect(appAssistantForbidsCoordinator(null)).toBe(false)
    expect(appAssistantForbidsCoordinator(undefined)).toBe(false)
  })
})

describe('[COMP:api/chat-route] isDocSurface', () => {
  // The surface signal that drives doc-skill injection independent of which
  // assistant is talking. True when the session originated in apps/app-web
  // (appOrigin='doc') or is a doc comment thread.
  it('is true for an appOrigin=doc session', () => {
    expect(isDocSurface({ appOrigin: 'doc', channelType: 'web' })).toBe(true)
  })
  it('is true for a doc_thread channel (comment reply)', () => {
    expect(isDocSurface({ appOrigin: null, channelType: 'doc_thread' })).toBe(true)
  })
  it('is false for ordinary web / telegram sessions', () => {
    expect(isDocSurface({ appOrigin: null, channelType: 'web' })).toBe(false)
    expect(isDocSurface({ appOrigin: 'web', channelType: 'telegram' })).toBe(false)
  })
})

describe('[COMP:api/chat-route] isAppSurface', () => {
  // The app-web workspace surfaces (SurfaceChatPanel origins, mig 255) get
  // the doc tools injected AMBIENTLY — weak on-request steering, not the
  // page-first protocol. Doc itself and plain chat are NOT app surfaces.
  it('is true for every SurfaceChatPanel origin', () => {
    for (const origin of ['brain', 'studio', 'workflow', 'approvals', 'knowledge-base']) {
      expect(isAppSurface({ appOrigin: origin })).toBe(true)
    }
  })
  it('is false for doc, chat, and unscoped sessions', () => {
    expect(isAppSurface({ appOrigin: 'doc' })).toBe(false)
    expect(isAppSurface({ appOrigin: 'chat' })).toBe(false)
    expect(isAppSurface({ appOrigin: null })).toBe(false)
  })
})


describe('[COMP:api/chat-route] buildActivePageInstruction', () => {
  // Regression guard for the 2026-06-02 orphan-page incident: a user wrote
  // their project bullets into "New draft", asked the doc assistant (from
  // that page's comment thread) to organize them, and the model authored a
  // SEPARATE "Project Portfolio" page via renderPage — leaving the open page
  // untouched and the new page invisible to the user. Root cause: the
  // non-empty branch advertised renderPage ("To author a brand-new page call
  // renderPage") as a co-equal option. The fix steers every active-page turn
  // to patchPage and gates renderPage behind an explicit new-page request.
  it('empty page: builds in place and forbids renderPage', () => {
    const out = buildActivePageInstruction({ isEmptyPage: true, isCommentThread: false })
    expect(out).toContain('EMPTY')
    expect(out).toContain('`patchPage`')
    expect(out).toContain('Do NOT call `renderPage`')
  })

  it('non-empty page: steers to patchPage and only permits renderPage on an explicit request', () => {
    const out = buildActivePageInstruction({ isEmptyPage: false, isCommentThread: false })
    expect(out).toContain('`patchPage`')
    expect(out).toContain('looking at THIS')
    // renderPage is gated behind EXPLICIT user intent, never offered as the
    // default "author a brand-new page" path that orphaned the user's work.
    expect(out).toContain('Do NOT call `renderPage` unless the user EXPLICITLY asks')
    expect(out).not.toContain('To author a brand-new page call `renderPage`')
  })

  it('non-empty comment-thread reply: forbids renderPage outright (request is about this page)', () => {
    const out = buildActivePageInstruction({ isEmptyPage: false, isCommentThread: true })
    expect(out).toContain('comment-thread reply')
    expect(out).toContain('never call `renderPage` here')
  })

  it('comment-thread flag is inert on an empty page (the empty guard already forbids renderPage)', () => {
    const thread = buildActivePageInstruction({ isEmptyPage: true, isCommentThread: true })
    const noThread = buildActivePageInstruction({ isEmptyPage: true, isCommentThread: false })
    expect(thread).toBe(noThread)
  })
})

describe('[COMP:api/chat-route] buildViewingSkillBlock', () => {
  const base = {
    rowId: 'row-1',
    name: 'Research HKTV Mall Shop Contacts',
    description: 'Finds decision-maker contacts for HKTV Mall shops',
    whenToUse: 'Use when researching a specific HKTV Mall shop',
    content: '1. Establish the anchor.\n2. Verify identity.',
    state: 'active' as const,
    activatedAt: new Date('2026-06-01T00:00:00Z'),
  }

  it('carries the identity, the saved body, and the "this skill" resolution line', () => {
    const out = buildViewingSkillBlock(base)
    expect(out).toContain('# Currently viewing — workspace skill')
    expect(out).toContain('"Research HKTV Mall Shop Contacts"')
    expect(out).toContain('row id: row-1')
    expect(out).toContain('status: active')
    expect(out).toContain('When to use: Use when researching a specific HKTV Mall shop')
    expect(out).toContain('1. Establish the anchor.')
    expect(out).toContain('this skill')
  })

  it('is tool-agnostic and honest about the editor: last SAVED version, propose text in chat', () => {
    const out = buildViewingSkillBlock(base)
    // Tool-awareness rule: never name a tool that may not be injected.
    expect(out).not.toMatch(/skill_manage|proposeSkill|patchPage|useSkill/)
    expect(out).toContain('last SAVED version')
    expect(out).toContain('propose the exact revised text in chat')
  })

  it('derives status: stale wins, never-activated reads as suggested', () => {
    expect(
      buildViewingSkillBlock({ ...base, state: 'stale' }),
    ).toContain('status: stale (needs re-review)')
    expect(
      buildViewingSkillBlock({ ...base, activatedAt: undefined }),
    ).toContain('status: suggested')
  })

  it('omits the when-to-use line when absent and truncates an over-cap legacy body', () => {
    const noWhen = buildViewingSkillBlock({ ...base, whenToUse: undefined })
    expect(noWhen).not.toContain('When to use:')
    const long = buildViewingSkillBlock({ ...base, content: 'x'.repeat(7000) })
    expect(long).toContain('…(truncated)')
    expect(long.length).toBeLessThan(7000)
  })
})

describe('[COMP:api/chat-viewing-deck] buildViewingDeckBlock', () => {
  const deck = {
    id: 'deck-1',
    title: 'Seed Round Deck',
    version: 3,
    slides: [
      { title: 'The problem', layout: 'statement' },
      { title: 'Agenda' },
      { title: 'Traction', layout: 'stats' },
    ],
  }

  it('carries the identity, the 0-based slide outline, and the "this deck" resolution line', () => {
    const out = buildViewingDeckBlock(deck)
    expect(out).toContain('# Currently viewing — deck')
    expect(out).toContain('"Seed Round Deck"')
    expect(out).toContain('deckId: deck-1')
    expect(out).toContain('version: 3')
    expect(out).toContain('0: "The problem" (statement)')
    expect(out).toContain('1: "Agenda"')
    expect(out).not.toContain('1: "Agenda" (content)') // default layout unannotated
    expect(out).toContain('this deck')
    expect(out).toContain('title slide excluded')
  })

  it('is tool-agnostic (tool-awareness rule)', () => {
    const out = buildViewingDeckBlock(deck)
    expect(out).not.toMatch(/updatePowerpoint|generatePowerpoint|getPowerpoint|sendFile/)
  })
})

describe('[COMP:api/chat-route] resolveStickyChannelId', () => {
  it('uses an explicit channelId when provided (feed-web sticky tuning chat)', () => {
    expect(resolveStickyChannelId('tuning', 'some-session-id')).toBe('tuning')
  })

  it('regression: falls back to the requested sessionId so a new chat reunites on one session', () => {
    // A brand-new chat mints a temp UUID, sends it as sessionId, and it misses
    // findSessionById. Reusing it as the sticky channel id is what keeps every
    // turn (and the concurrent double-send) on ONE session row instead of
    // minting a fresh random-channel session per turn (duplicate Recents bug).
    expect(resolveStickyChannelId(undefined, 'temp-uuid-123')).toBe('temp-uuid-123')
    expect(resolveStickyChannelId(null, 'temp-uuid-123')).toBe('temp-uuid-123')
  })

  it('returns undefined when neither is present (caller mints a random channel)', () => {
    expect(resolveStickyChannelId(undefined, undefined)).toBeUndefined()
    expect(resolveStickyChannelId(null, null)).toBeUndefined()
  })

  it('treats whitespace-only values as absent', () => {
    expect(resolveStickyChannelId('   ', '  ')).toBeUndefined()
    expect(resolveStickyChannelId('   ', 'temp-uuid-123')).toBe('temp-uuid-123')
  })
})

describe('[COMP:api/chat-route] attachTurnContext — turn-context envelope', () => {
  const ctx = '# User Context\nCurrent date and time: Wednesday, June 10, 2026 at 11:40 PM HKT'

  it('appends the envelope as a trailing text block on a string-content user message', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'format this page' },
    ]
    const out = attachTurnContext(messages, ctx)
    expect(out).not.toBeNull()
    expect(out).not.toBe(messages)
    const last = out![out!.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    const blocks = last.content as Array<{ type: string; text?: string }>
    expect(blocks[0]).toEqual({ type: 'text', text: 'format this page' })
    expect(blocks[1].type).toBe('text')
    expect(blocks[1].text).toContain('<turn_context>')
    expect(blocks[1].text).toContain(ctx)
    expect(blocks[1].text!.trimEnd().endsWith('</turn_context>')).toBe(true)
    // The input array is untouched — the envelope must never reach the
    // persisted history (cache-prefix invariant).
    expect(typeof messages[1].content).toBe('string')
  })

  it('appends the envelope to an existing content-block array', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] as Message['content'] },
    ]
    const out = attachTurnContext(messages, ctx)
    const blocks = out![0].content as Array<{ type: string; text?: string }>
    expect(blocks).toHaveLength(2)
    expect(blocks[1].text).toContain('<turn_context>')
  })

  it('returns null when no plain trailing user message can carry the envelope', () => {
    expect(attachTurnContext([{ role: 'assistant', content: 'x' }], ctx)).toBeNull()
    expect(attachTurnContext([], ctx)).toBeNull()
    const toolCarrier: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', name: 'patchPage', content: 'ok' },
        ] as Message['content'],
      },
    ]
    expect(attachTurnContext(toolCarrier, ctx)).toBeNull()
  })

  it('returns the input unchanged for an empty turn context', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }]
    expect(attachTurnContext(messages, '')).toBe(messages)
    expect(attachTurnContext(messages, '   ')).toBe(messages)
  })
})
