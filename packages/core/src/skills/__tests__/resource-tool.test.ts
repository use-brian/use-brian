import { describe, expect, it } from 'vitest'
import { createReadSkillResourceTool, createSearchSkillResourcesTool } from '../resource-tool.js'
import type { SkillContent } from '../types.js'

const ctx = {
  assistantId: 'a-1', userId: 'u-1', sessionId: 's-1', appId: 'Use Brian',
  channelType: 'web', channelId: 'c-1', workspaceId: 'w-1',
  abortSignal: new AbortController().signal,
}

const skill: SkillContent = {
  id: 'finance', name: 'Finance', description: 'Analyze finances.', category: 'research',
  requiresConnectors: [], source: 'community', content: 'Read the right resource.', bundleVersion: 2,
  resources: [{
    path: 'references/margins.md', kind: 'reference', name: 'margins.md',
    content: 'Gross margin equals revenue less COGS.', contentHash: 'abc',
  }],
}

describe('[COMP:skills/resource-tool] bundle resource tools', () => {
  it('reads one exact resource from an offerable skill', async () => {
    const tool = createReadSkillResourceTool({ getAvailableSkills: () => [skill] })
    const result = await tool.execute({ skill: 'finance', path: 'references/margins.md' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ path: 'references/margins.md', content: skill.resources![0]!.content })
  })

  // Failures are message-first TEXT, never a `{ error, validPaths }` object the
  // model has to parse JSON to read (docs/architecture/engine/tool-executor.md
  // → "Failure copy"). The valid paths are the remedy, so they stay in the text.
  it('fails closed for unavailable skills and lists valid paths on a miss', async () => {
    const hidden = createReadSkillResourceTool({ getAvailableSkills: () => [] })
    const unavailable = await hidden.execute({ skill: 'finance', path: 'references/margins.md' }, ctx)
    expect(unavailable.isError).toBe(true)
    expect(typeof unavailable.data).toBe('string')
    expect(unavailable.data as string).toContain('no skill with the id "finance" is available')
    expect(unavailable.data as string).toContain('Do NOT retry this exact skill id.')

    const visible = createReadSkillResourceTool({ getAvailableSkills: () => [skill] })
    const miss = await visible.execute({ skill: 'finance', path: 'references/nope.md' }, ctx)
    expect(miss.isError).toBe(true)
    expect(typeof miss.data).toBe('string')
    expect(miss.data as string).toContain('found no resource "references/nope.md" in skill "finance"')
    expect(miss.data as string).toContain('Valid paths in this bundle: references/margins.md')
    expect(miss.data as string).toContain('Do NOT retry this exact path.')
  })

  it('says a legacy bundle has no addressable resources rather than "not found"', async () => {
    const legacy: SkillContent = { ...skill, bundleVersion: 1, resources: undefined }
    const tool = createReadSkillResourceTool({ getAvailableSkills: () => [legacy] })
    const res = await tool.execute({ skill: 'finance', path: 'references/margins.md' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data as string).toContain('legacy (v1) bundle')
    expect(res.data as string).toContain('Call useSkill with skill "finance"')
  })

  it('searches within one offerable bundle', async () => {
    const tool = createSearchSkillResourcesTool({ getAvailableSkills: () => [skill] })
    const result = await tool.execute({ skill: 'finance', query: 'gross margin', limit: 5 }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ matches: [expect.objectContaining({ path: 'references/margins.md' })] })
  })

  it('requires the root skill to be activated when an activation guard is wired', async () => {
    let activated = false
    const tool = createReadSkillResourceTool({
      getAvailableSkills: () => [skill],
      isSkillActivated: () => activated,
    })
    const blocked = await tool.execute({ skill: 'finance', path: 'references/margins.md' }, ctx)
    expect(blocked.isError).toBe(true)
    expect(typeof blocked.data).toBe('string')
    expect(blocked.data as string).toContain('not activated in this turn')
    expect(blocked.data as string).toContain('Call useSkill with skill "finance" first')

    activated = true
    const allowed = await tool.execute({ skill: 'finance', path: 'references/margins.md' }, ctx)
    expect(allowed.isError).toBeFalsy()
  })
})
