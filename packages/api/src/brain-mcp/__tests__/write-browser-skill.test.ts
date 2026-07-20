/**
 * The brain-MCP logic-block write tool (computer-use R2-5/R2-9): the OSS
 * authoring skill's sync target. The schema REQUIRES the review artifacts —
 * recording + declared sends — and the server re-extracts the effect
 * contract from the code, rejecting flagged constructs and any declaration
 * mismatch. Write-scope keys only (the tool is not in READ_TOOL_NAMES).
 */
import { describe, it, expect } from 'vitest'
import { createInMemoryBrowserSkillStore } from '@use-brian/core'
import { buildWriteBrowserSkillTool } from '../tools.js'

const GOOD_CODE = `
def run(runner, params):
    runner.open("https://www.instagram.com/")
    runner.snapshot()
    runner.fill(runner.find("Message"), params["message"])
    runner.submit(runner.find("Send"), "Send the DM")
`

const RECORDING = [{ step: 1, action: 'open', url: 'https://www.instagram.com/' }]

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n')
}

describe('[COMP:mcp/write-browser-skill] writeBrowserSkill (brain MCP)', () => {
  it('is a write tool: absent from the read-key surface by construction', async () => {
    // READ_TOOL_NAMES is the read-key allowlist; writeBrowserSkill is not in
    // it, so a `read` key never sees or calls it. Assert against the module
    // source so a future allowlist edit trips this.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../tools.ts', import.meta.url), 'utf8'),
    )
    const allowlist = /const READ_TOOL_NAMES = new Set<string>\(\[[\s\S]*?\]\)/.exec(src)?.[0] ?? ''
    expect(allowlist).not.toContain('writeBrowserSkill')
  })

  it('saves a block whose declared sends match the extracted contract', async () => {
    const store = createInMemoryBrowserSkillStore()
    const tool = buildWriteBrowserSkillTool(store, 'ws-1')
    const result = await tool.handler({
      name: 'dm-followers',
      site: 'instagram.com',
      description: 'DM new followers',
      code: GOOD_CODE,
      paramsSchema: { properties: { message: { type: 'string' } } },
      recording: RECORDING,
      declaredSends: ['Send the DM'],
    })
    expect(result.isError ?? false).toBe(false)
    expect(textOf(result)).toContain('dm-followers')
    const saved = await store.getByName({ workspaceId: 'ws-1', name: 'dm-followers' })
    expect(saved?.origin).toBe('external')
    expect(saved?.contract.terminalSends).toHaveLength(1)
    expect(saved?.recording).toEqual(RECORDING)
  })

  it('REJECTS a declared-send mismatch - the contract is the review artifact', async () => {
    const store = createInMemoryBrowserSkillStore()
    const tool = buildWriteBrowserSkillTool(store, 'ws-1')
    const result = await tool.handler({
      name: 'dm-followers',
      site: 'instagram.com',
      description: 'x',
      code: GOOD_CODE,
      recording: RECORDING,
      declaredSends: [], // the code sends once - the author must say so
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Declare exactly')
    expect(await store.getByName({ workspaceId: 'ws-1', name: 'dm-followers' })).toBeNull()
  })

  it('REJECTS flagged constructs (fail-closed authoring gate)', async () => {
    const store = createInMemoryBrowserSkillStore()
    const tool = buildWriteBrowserSkillTool(store, 'ws-1')
    const result = await tool.handler({
      name: 'evil',
      site: 'instagram.com',
      description: 'x',
      code: 'import subprocess\n\ndef run(runner, params):\n    subprocess.run(["agent-browser", "click", "@e1"])\n',
      recording: RECORDING,
      declaredSends: [],
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('governed runner')
    expect(await store.getByName({ workspaceId: 'ws-1', name: 'evil' })).toBeNull()
  })

  it('same name updates in place and bumps the version', async () => {
    const store = createInMemoryBrowserSkillStore()
    const tool = buildWriteBrowserSkillTool(store, 'ws-1')
    const base = {
      name: 'dm-followers',
      site: 'instagram.com',
      description: 'v1',
      code: GOOD_CODE,
      recording: RECORDING,
      declaredSends: ['Send the DM'],
    }
    await tool.handler(base)
    const updated = await tool.handler({ ...base, description: 'v2 hardened' })
    expect(updated.isError ?? false).toBe(false)
    const saved = await store.getByName({ workspaceId: 'ws-1', name: 'dm-followers' })
    expect(saved?.version).toBe(2)
    expect(saved?.description).toBe('v2 hardened')
  })
})

describe('[COMP:oss/browser-skill-author] The OSS authoring skill teaches the governed vocabulary', () => {
  it('SKILL.md documents every runner verb, the terminal submit, and the sync tool - prose and runner cannot drift', async () => {
    const fs = await import('node:fs/promises')
    const { RUNNER_VERBS } = await import('@use-brian/core')
    const skillMd = await fs.readFile(
      new URL('../../../../../.claude/skills/browser-skill-author/SKILL.md', import.meta.url),
      'utf8',
    )
    for (const verb of RUNNER_VERBS) {
      expect(skillMd, `SKILL.md must document runner.${verb}`).toContain(verb)
    }
    expect(skillMd).toContain('writeBrowserSkill')
    expect(skillMd).toContain('declaredSends')
  })
})
