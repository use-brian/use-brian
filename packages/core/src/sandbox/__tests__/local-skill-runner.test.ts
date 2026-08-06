import { describe, expect, it } from 'vitest'
import { createInMemoryBlockApprovals, createInMemoryBrowserSkillGrantStore, createInMemoryBrowserSkillStore } from '../browser-skills.js'
import { extractEffectContract } from '../effect-contract.js'
import { createInMemoryBrowserProfileStore } from '../profiles.js'
import { createSkillRunnerTools } from '../skill-runner.js'
import { validateLocalRecording } from '../local-skill-runner.js'
import type { BrowserProvider } from '../types.js'
import type { Tool, ToolContext } from '../../tools/types.js'

function context(): ToolContext {
  return {
    userId: 'user-1',
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'app-1',
    channelType: 'web',
    channelId: 'chan-1',
    workspaceId: 'ws-1',
    abortSignal: new AbortController().signal,
  }
}

function localProvider(): BrowserProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    kind: 'local',
    calls,
    async navigate(_ctx, url) {
      calls.push(`navigate:${url}`)
      return { url }
    },
    async snapshot() {
      calls.push('snapshot')
      return {
        url: 'https://www.google.com/',
        title: 'Google',
        nodes: [
          { ref: '@e1', role: 'textbox', name: 'Search' },
          { ref: '@e2', role: 'button', name: 'Google Search' },
        ],
      }
    },
    async click(_ctx, ref) {
      calls.push(`click:${ref}`)
    },
    async type(_ctx, ref, text) {
      calls.push(`type:${ref}:${text}`)
    },
    async currentUrl() {
      return { url: 'https://www.google.com/', title: 'Google' }
    },
    async stop() {},
  }
}

async function run(tool: Tool, input: Record<string, unknown>) {
  return tool.execute(tool.inputSchema.parse(input), context())
}

describe('[COMP:sandbox/local-skill-runner] Local browser skill recording and replay', () => {
  it('saves a session recording as a skill and clears the consumed trace', async () => {
    const skills = createInMemoryBrowserSkillStore()
    let trace = [
      { action: 'open' as const, url: 'https://www.google.com/' },
      { action: 'fill' as const, detail: 'Search', text: 'use brian' },
      { action: 'submit' as const, detail: 'Google Search', description: 'Search Google for use brian' },
    ]
    const tools = createSkillRunnerTools({
      provider: null,
      binding: null,
      skills,
      getSessionTrace: () => trace,
      clearSessionTrace: () => {
        trace = []
      },
    })

    const result = await run(tools.saveBrowserSkill, {
      name: 'google-search',
      description: 'Search Google',
      parameters: { query: 'use brian' },
    })
    expect(result.isError ?? false).toBe(false)
    expect(trace).toEqual([])
    const saved = await skills.getByName({ workspaceId: 'ws-1', name: 'google-search' })
    expect(saved?.site).toBe('google.com')
    expect(saved?.recording).toMatchObject([
      { action: 'open' },
      { action: 'fill', detail: 'Search', text: 'use brian', param: 'query' },
      { action: 'submit', detail: 'Google Search', description: 'Search Google for use brian' },
    ])
    expect(saved?.contract.terminalSends).toHaveLength(1)
  })

  it('replays a local skill without model snapshots and auto-approves a granted submit', async () => {
    const local = localProvider()
    const skills = createInMemoryBrowserSkillStore()
    const profiles = createInMemoryBrowserProfileStore()
    const profile = await profiles.create({
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      name: 'My Browser',
      defaultBackend: 'local',
      enabledAssistantIds: ['asst-1'],
    })
    const code = `def run(runner, params):\n    runner.open("https://www.google.com/")\n    runner.snapshot()\n    runner.fill(runner.find("Search"), params["query"])\n    runner.submit(runner.find("Google Search"), "Search Google for use brian")\n`
    const skill = await skills.create({
      workspaceId: 'ws-1',
      name: 'google-search',
      site: 'google.com',
      code,
      paramsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      contract: extractEffectContract({ code, site: 'google.com' }),
      recording: [
        { step: 1, action: 'open', url: 'https://www.google.com/' },
        { step: 2, action: 'fill', detail: 'Search', text: 'use brian', param: 'query' },
        { step: 3, action: 'submit', detail: 'Google Search', description: 'Search Google for use brian' },
      ],
      origin: 'assistant',
    })
    const approvals = createInMemoryBlockApprovals()
    const grants = createInMemoryBrowserSkillGrantStore()
    await grants.create({ workspaceId: 'ws-1', skillId: skill.id, profileId: profile.id, grantedBy: 'user-1' })
    const tools = createSkillRunnerTools({
      provider: null,
      local,
      binding: null,
      skills,
      profiles: { store: profiles, assistantClearance: async () => 'confidential' },
      grants,
      approvals,
      approvalWaitMs: 100,
      pollMs: 5,
    })

    const result = await run(tools.runBrowserSkill, {
      skill: 'google-search',
      profile: 'My Browser',
      params: { query: 'repeatable search' },
    })
    expect(result.isError ?? false).toBe(false)
    expect(result.meta).toMatchObject({ backend: 'local' })
    expect(local.calls).toEqual([
      'navigate:https://www.google.com/',
      'snapshot',
      'type:@e1:repeatable search',
      'snapshot',
      'click:@e2',
      'snapshot',
    ])
    expect([...approvals.rows.values()].some((row) => row.status === 'auto_approved')).toBe(true)
  })

  it('rejects recordings that leave their declared site', async () => {
    const skills = createInMemoryBrowserSkillStore()
    const tools = createSkillRunnerTools({
      provider: null,
      binding: null,
      skills,
      getSessionTrace: () => [
        { action: 'open' as const, url: 'https://www.google.com/' },
        { action: 'open' as const, url: 'https://example.com/' },
      ],
    })

    const result = await run(tools.saveBrowserSkill, { name: 'cross-site' })
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('Every recorded navigation must stay')
    expect(await skills.getByName({ workspaceId: 'ws-1', name: 'cross-site' })).toBeNull()
  })

  it('rejects send-like clicks and unsupported actions when the recording diverges from code', () => {
    const clickSendCode =
      'def run(runner, params):\n    runner.open("https://example.com/")\n    runner.click(runner.find("Send"))\n'
    const readOnlyContract = extractEffectContract({
      code: clickSendCode,
      site: 'example.com',
    })
    expect(validateLocalRecording({
      site: 'example.com',
      code: clickSendCode,
      contract: readOnlyContract,
      recording: [
        { step: 1, action: 'open', url: 'https://example.com/' },
        { step: 2, action: 'click', detail: 'Send' },
      ],
    })).toContain('recording contains 1 terminal send')
    expect(validateLocalRecording({
      site: 'example.com',
      code: 'def run(runner, params):\n    runner.open("https://example.com/")\n    runner.scroll(800)\n',
      contract: readOnlyContract,
      recording: [
        { step: 1, action: 'open', url: 'https://example.com/' },
        { step: 2, action: 'scroll' },
      ],
    })).toContain('unsupported local action')
  })
})
