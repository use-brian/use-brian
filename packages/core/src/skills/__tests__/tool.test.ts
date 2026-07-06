/**
 * Unit tests for the useSkill tool.
 * Component tag: [COMP:skills/tool].
 *
 * Verifies createUseSkillTool: the tool metadata (read-only, concurrency-
 * safe), returning a skill's instructions for a known id, the error
 * result for an unknown id, that the available-skills list is re-read
 * on every execute call (not captured at construction), and that the
 * optional `recordInvocation` callback fires on successful resolution
 * but not on lookup failure.
 */

import { describe, it, expect, vi } from 'vitest'
import { createUseSkillTool } from '../tool.js'
import type { SkillContent } from '../types.js'

function skillContent(over: Partial<SkillContent> = {}): SkillContent {
  return {
    id: 'research-helper',
    name: 'Research Helper',
    description: 'Helps with research.',
    category: 'research',
    requiresConnectors: [],
    source: 'builtin',
    content: 'Step 1. Do the research.',
    ...over,
  }
}

// useSkill ignores the ToolContext — a minimal valid one satisfies the type.
const ctx = {
  assistantId: 'a-1',
  userId: 'u-1',
  sessionId: 's-1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c-1',
  workspaceId: 'w-1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:skills/tool] createUseSkillTool', () => {
  it('exposes a read-only, concurrency-safe useSkill tool', () => {
    const tool = createUseSkillTool({ getAvailableSkills: () => [] })
    expect(tool.name).toBe('useSkill')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
  })

  it('returns the skill instructions for a known id', async () => {
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'research-helper', content: 'Do research.' })],
    })
    const res = await tool.execute({ skill: 'research-helper' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.data).toEqual({
      skill: 'research-helper',
      name: 'Research Helper',
      instructions: 'Do research.',
    })
  })

  it('appends a blueprint-fill directive when the skill is bound to a blueprint', async () => {
    const tool = createUseSkillTool({
      getAvailableSkills: () => [
        skillContent({ id: 'hktv-shops', content: 'Research the shops.', blueprintId: 'bp-42' }),
      ],
    })
    const res = await tool.execute({ skill: 'hktv-shops' }, ctx)
    expect(res.isError).toBeFalsy()
    const instructions = (res.data as { instructions: string }).instructions
    // The procedure is preserved, then a directive steers output into the
    // linked blueprint via the fill tool (structural-synthesis Phase 2).
    expect(instructions).toContain('Research the shops.')
    expect(instructions).toContain('fillBlueprintFromBrain')
    expect(instructions).toContain('bp-42')
  })

  it('leaves instructions untouched for a skill with no blueprint', async () => {
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'plain', content: 'Just do it.' })],
    })
    const res = await tool.execute({ skill: 'plain' }, ctx)
    const instructions = (res.data as { instructions: string }).instructions
    expect(instructions).toBe('Just do it.')
    expect(instructions).not.toContain('fillBlueprintFromBrain')
  })

  it('returns an error result naming the missing skill for an unknown id', async () => {
    const tool = createUseSkillTool({ getAvailableSkills: () => [skillContent()] })
    const res = await tool.execute({ skill: 'ghost-skill' }, ctx)
    expect(res.isError).toBe(true)
    expect((res.data as { error: string }).error).toContain('ghost-skill')
  })

  it('re-reads the available skills on each call', async () => {
    let skills: SkillContent[] = []
    const tool = createUseSkillTool({ getAvailableSkills: () => skills })
    expect((await tool.execute({ skill: 'late' }, ctx)).isError).toBe(true)

    skills = [skillContent({ id: 'late', name: 'Late Skill', content: 'Now available.' })]
    const res = await tool.execute({ skill: 'late' }, ctx)
    expect(res.isError).toBeFalsy()
    expect((res.data as { name: string }).name).toBe('Late Skill')
  })

  it('fires recordInvocation with the resolved slug on successful resolution', async () => {
    const recordInvocation = vi.fn()
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'research-helper' })],
      recordInvocation,
    })

    const res = await tool.execute({ skill: 'research-helper' }, ctx)

    expect(res.isError).toBeFalsy()
    expect(recordInvocation).toHaveBeenCalledTimes(1)
    expect(recordInvocation).toHaveBeenCalledWith('research-helper')
  })

  it('does NOT fire recordInvocation when the skill lookup fails', async () => {
    const recordInvocation = vi.fn()
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'research-helper' })],
      recordInvocation,
    })

    const res = await tool.execute({ skill: 'ghost-skill' }, ctx)

    expect(res.isError).toBe(true)
    expect(recordInvocation).not.toHaveBeenCalled()
  })

  it('swallows synchronous recordInvocation errors — must not break the tool result', async () => {
    const recordInvocation = vi.fn(() => {
      throw new Error('counter store down')
    })
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'research-helper' })],
      recordInvocation,
    })

    // The execute promise must still resolve with the skill data — a
    // failing counter must never starve the model of its tool result.
    const res = await tool.execute({ skill: 'research-helper' }, ctx)
    expect(res.isError).toBeFalsy()
    expect((res.data as { skill: string }).skill).toBe('research-helper')
    expect(recordInvocation).toHaveBeenCalledTimes(1)
  })

  it('returns expandContent output as the instructions when provided', async () => {
    const expandContent = vi.fn(async (s: SkillContent) => `${s.content} [expanded]`)
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'research-helper', content: 'See {{template:x}}' })],
      expandContent,
    })
    const res = await tool.execute({ skill: 'research-helper' }, ctx)
    expect(res.isError).toBeFalsy()
    expect((res.data as { instructions: string }).instructions).toBe('See {{template:x}} [expanded]')
    expect(expandContent).toHaveBeenCalledTimes(1)
  })

  it('falls back to raw content when expandContent throws — never breaks the result', async () => {
    const expandContent = vi.fn(async () => {
      throw new Error('file store down')
    })
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'research-helper', content: 'RAW BODY' })],
      expandContent,
    })
    const res = await tool.execute({ skill: 'research-helper' }, ctx)
    expect(res.isError).toBeFalsy()
    expect((res.data as { instructions: string }).instructions).toBe('RAW BODY')
  })

  it('swallows asynchronous recordInvocation rejections — must not break the tool result', async () => {
    const recordInvocation = vi.fn(async () => {
      throw new Error('async counter store down')
    })
    const tool = createUseSkillTool({
      getAvailableSkills: () => [skillContent({ id: 'research-helper' })],
      recordInvocation,
    })

    const res = await tool.execute({ skill: 'research-helper' }, ctx)
    expect(res.isError).toBeFalsy()
    // Give the rejection a tick to settle so an unhandled rejection
    // surfaces if the swallow path is missing.
    await Promise.resolve()
    expect(recordInvocation).toHaveBeenCalledTimes(1)
  })
})
