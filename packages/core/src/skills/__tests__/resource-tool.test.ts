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

  it('fails closed for unavailable skills and lists valid paths on a miss', async () => {
    const hidden = createReadSkillResourceTool({ getAvailableSkills: () => [] })
    expect((await hidden.execute({ skill: 'finance', path: 'references/margins.md' }, ctx)).isError).toBe(true)

    const visible = createReadSkillResourceTool({ getAvailableSkills: () => [skill] })
    const miss = await visible.execute({ skill: 'finance', path: 'references/nope.md' }, ctx)
    expect(miss.isError).toBe(true)
    expect(miss.data).toMatchObject({ validPaths: ['references/margins.md'] })
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
    expect(blocked.data).toMatchObject({ error: expect.stringContaining('useSkill') })

    activated = true
    const allowed = await tool.execute({ skill: 'finance', path: 'references/margins.md' }, ctx)
    expect(allowed.isError).toBeFalsy()
  })
})
