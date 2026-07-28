import { describe, expect, it } from 'vitest'
import {
  injectContentPlanningTools,
  resolveContentPlanningPrompt,
  resolveContentPlanningSoul,
} from '../host-hooks.js'
import { DRAFT_SESSION_ADDENDUM } from '../prompt.js'

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
