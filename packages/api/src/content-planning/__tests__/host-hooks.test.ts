import { describe, expect, it, vi } from 'vitest'
import type { ContentIdeasStore } from '../../db/content-ideas-store.js'
import type { ContentPlanStore } from '../../db/content-plan-store.js'
import {
  buildContentPlanningPromptResolver,
  injectContentPlanningTools,
  resolveContentPlanningPrompt,
  resolveContentPlanningSoul,
} from '../host-hooks.js'
import { DRAFT_SESSION_ADDENDUM, PLAN_SESSION_ADDENDUM } from '../prompt.js'

describe('[COMP:feed/content-planning-hooks] open planning host hooks', () => {
  it('injects the cardboard tool only for distribution draft sessions', async () => {
    const draftTools = new Map()
    await injectContentPlanningTools({
      tools: draftTools,
      userId: 'user-1',
      assistant: {
        id: 'assistant-1',
        kind: 'app',
        appType: 'distribution',
      },
      session: { id: 'session-1', mode: 'draft', channelType: 'web' },
    })
    expect(draftTools.has('proposeDrafts')).toBe(true)

    const tuningTools = new Map()
    await injectContentPlanningTools({
      tools: tuningTools,
      userId: 'user-1',
      assistant: {
        id: 'assistant-1',
        kind: 'app',
        appType: 'distribution',
      },
      session: { id: 'session-2', mode: null, channelType: 'web' },
    })
    expect(tuningTools.has('proposeDrafts')).toBe(false)
  })

  it('provides the open public-voice soul for distribution assistants', () => {
    const soul = resolveContentPlanningSoul({
      appType: 'distribution',
      name: 'Brian',
      team: { name: 'Acme', purpose: 'Build calm software' },
      mode: 'tuning',
    })
    expect(soul).toContain('content-planning assistant for Acme')
    expect(soul).toContain('Build calm software')
    expect(resolveContentPlanningSoul({
      appType: null,
      name: 'Brian',
    })).toBeNull()
  })
})

describe('[COMP:feed/content-planning-prompt] draft prompt', () => {
  it('is injected only in draft mode and keeps draft bodies in the tool', () => {
    expect(resolveContentPlanningPrompt({
      mode: 'draft',
      channelType: 'web',
    })).toBe(DRAFT_SESSION_ADDENDUM)
    expect(DRAFT_SESSION_ADDENDUM).toContain('Put every proposed post body')
    expect(resolveContentPlanningPrompt({
      mode: null,
      channelType: 'web',
    })).toBeNull()
  })
})

describe('[COMP:feed/content-planning-prompt] plan prompt (P10 clarify + §6 context)', () => {
  const planStore = {
    getBrief: vi.fn(async () => ({
      assistantId: 'assistant-1',
      monthStart: '2026-08-01',
      brief: 'Launch-focused month\nDeep detail',
      themes: ['launch'],
      cadencePerWeek: 3,
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    })),
  } as unknown as ContentPlanStore
  const ideasStore = {
    listIdeas: vi.fn(async () => [
      {
        id: 'idea-1',
        text: 'Onboarding horror story\nas a thread',
      },
      { id: 'idea-2', text: 'Beta waitlist tease' },
    ]),
  } as unknown as ContentIdeasStore
  const now = () => new Date(2026, 7, 28)

  it('plan mode gets the addendum plus the live preset block', async () => {
    const resolve = buildContentPlanningPromptResolver({
      planStore,
      ideasStore,
      now,
    })
    const prompt = await resolve({
      mode: 'plan',
      channelType: 'web',
      assistantId: 'assistant-1',
    })
    expect(prompt).toContain('# Plan session output')
    expect(prompt).toContain('# Plan context (current state, auto-injected)')
    expect(prompt).toContain('Month 2026-08 brief: Launch-focused month')
    expect(prompt).toContain('Cadence: 3 per week')
    // Ideas carry id + first line only — draft fuel the model can name.
    expect(prompt).toContain('- [idea-1] Onboarding horror story')
    expect(prompt).not.toContain('as a thread')
    expect(prompt).toContain('- [idea-2] Beta waitlist tease')
    // The clarify contract rides the static addendum.
    expect(prompt).toContain('ONE consolidated clarifying question')
    expect(prompt).toContain('briefPatch')
  })

  it('degrades to the static addendum when the preset fetch fails, and stays static off plan mode', async () => {
    const broken = buildContentPlanningPromptResolver({
      planStore: {
        getBrief: vi.fn(async () => {
          throw new Error('db down')
        }),
      } as unknown as ContentPlanStore,
      ideasStore,
      now,
    })
    expect(
      await broken({ mode: 'plan', channelType: 'web', assistantId: 'a1' }),
    ).toBe(PLAN_SESSION_ADDENDUM)

    const resolve = buildContentPlanningPromptResolver({
      planStore,
      ideasStore,
      now,
    })
    expect(
      await resolve({ mode: 'draft', channelType: 'web', assistantId: 'a1' }),
    ).toBe(DRAFT_SESSION_ADDENDUM)
    // No assistant id (a consult without a session) — static only, no fetch.
    expect(await resolve({ mode: 'plan', channelType: 'web' })).toBe(
      PLAN_SESSION_ADDENDUM,
    )
    expect(await resolve({ mode: null, channelType: 'web' })).toBeNull()
  })

  it('renders unset presets honestly instead of inventing them', async () => {
    const resolve = buildContentPlanningPromptResolver({
      planStore: {
        getBrief: vi.fn(async () => null),
      } as unknown as ContentPlanStore,
      ideasStore: {
        listIdeas: vi.fn(async () => []),
      } as unknown as ContentIdeasStore,
      now,
    })
    const prompt = await resolve({
      mode: 'plan',
      channelType: 'web',
      assistantId: 'assistant-1',
    })
    expect(prompt).toContain('brief: (not set)')
    expect(prompt).toContain('Cadence: (not set)')
    expect(prompt).toContain('(empty)')
  })
})
