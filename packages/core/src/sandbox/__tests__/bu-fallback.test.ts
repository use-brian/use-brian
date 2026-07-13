/**
 * The browser-use watched fallback + self-heal (R2-1/R2-5/R2-7): a watched
 * exploration ALWAYS distills into a draft logic-block whose sends stay
 * gated; the agentic loop is cloud-only — unattended-on-local is an outright
 * refusal, and a local-default profile is never silently re-routed.
 */
import { describe, it, expect } from 'vitest'
import { createBuFallbackTool } from '../bu-fallback.js'
import { createSkillRunnerTools } from '../skill-runner.js'
import { distillTrace } from '../self-heal.js'
import { extractEffectContract, contractAllowsRun } from '../effect-contract.js'
import { createInMemoryBrowserSkillStore, createInMemoryBlockApprovals } from '../browser-skills.js'
import { createInMemoryBrowserProfileStore, createInMemorySessionVault } from '../profiles.js'
import { createInMemorySandboxTaskStore, createSandboxOrchestrator } from '../orchestrator.js'
import { StubSandboxProvider } from '../providers/stub.js'
import type { BuTraceStep } from '../types.js'
import type { ToolContext } from '../../tools/types.js'

function toolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'user-1',
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'app-1',
    channelType: 'web',
    channelId: 'chan-1',
    workspaceId: 'ws-1',
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

const DM_TRACE: BuTraceStep[] = [
  { step: 1, action: 'open', url: 'https://www.instagram.com/' },
  { step: 2, action: 'click', label: 'New follower Jane', url: 'https://www.instagram.com/' },
  { step: 3, action: 'fill', label: 'Message', text: 'Thanks for the follow!' },
  { step: 4, action: 'click', label: 'Send', detail: 'Send the DM' },
  { step: 5, action: 'done', text: 'DM sent to Jane' },
]

async function build(opts: { backend?: 'local' | 'cloud'; unattended?: boolean } = {}) {
  const provider = new StubSandboxProvider()
  const profileStore = createInMemoryBrowserProfileStore()
  const skillStore = createInMemoryBrowserSkillStore()
  const vault = createInMemorySessionVault()
  const orchestrator = createSandboxOrchestrator({
    provider,
    taskStore: createInMemorySandboxTaskStore(),
    vault,
    profileStore,
  })
  await profileStore.create({
    workspaceId: 'ws-1',
    ownerUserId: 'user-1',
    name: 'Personal IG',
    defaultBackend: opts.backend ?? 'cloud',
    enabledAssistantIds: ['asst-1'],
  })
  const profiles = { store: profileStore, vault, assistantClearance: async () => 'confidential' as const }
  const { browserExplore } = createBuFallbackTool({
    provider,
    binding: orchestrator.binding,
    skills: skillStore,
    profiles,
    unattendedEnabled: () => opts.unattended ?? false,
    getWorkspacePlan: async () => 'pro',
  })
  return { provider, skillStore, profiles, orchestrator, browserExplore }
}

async function run(tool: { execute: (i: never, c: ToolContext) => Promise<{ data: unknown; isError?: boolean; meta?: Record<string, unknown> }>; inputSchema: { parse: (i: unknown) => unknown } }, input: Record<string, unknown>, ctx = toolContext()) {
  return tool.execute(tool.inputSchema.parse(input) as never, ctx)
}

describe('[COMP:sandbox/bu-fallback] Watched agentic fallback (R2-1/R2-7)', () => {
  it('a watched run explores, then ALWAYS self-heals into a draft skill (R2-5)', async () => {
    const { provider, skillStore, browserExplore } = await build()
    provider.scriptBrowserUse({ trace: DM_TRACE, output: 'DM sent to Jane' })
    const result = await run(browserExplore, {
      goal: 'DM new followers a thank-you note',
      url: 'https://www.instagram.com/',
    })
    expect(result.isError ?? false).toBe(false)
    expect(String(result.data)).toContain('DM sent to Jane')
    expect(String(result.data)).toContain('draft browser skill')

    const skills = await skillStore.list({ workspaceId: 'ws-1' })
    expect(skills).toHaveLength(1)
    expect(skills[0].origin).toBe('self_heal')
    expect(skills[0].site).toBe('instagram.com')
    expect(skills[0].recording.length).toBeGreaterThan(0)
    // The draft keeps the terminal send TERMINAL — gated on replay.
    expect(skills[0].contract.terminalSends).toHaveLength(1)
    expect(contractAllowsRun(skills[0].contract)).toBe(true)
  })

  it('unattended BU is REFUSED on a local-default profile (R2-7: cloud-only), even fully enabled + paid', async () => {
    const { browserExplore } = await build({ backend: 'local', unattended: true })
    const result = await run(
      browserExplore,
      { goal: 'check notifications', url: 'https://www.linkedin.com/' },
      toolContext({ channelType: 'workflow' }),
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('cloud-only')
  })

  it('a WATCHED run on a local-default profile also refuses - no silent re-route to a datacenter IP', async () => {
    const { browserExplore } = await build({ backend: 'local' })
    const result = await run(browserExplore, {
      goal: 'check notifications',
      url: 'https://www.linkedin.com/',
    })
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('cloud')
  })

  it('autonomous paths without unattended mode stay hard-blocked (Barrier 2 posture)', async () => {
    const { browserExplore } = await build()
    const result = await run(
      browserExplore,
      { goal: 'x', url: 'https://example.com/' },
      toolContext({ channelType: 'workflow' }),
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('autonomous')
  })

  it('explores AS the profile: the identity binds the task (vault injection path)', async () => {
    const { provider, orchestrator, browserExplore } = await build()
    provider.scriptBrowserUse({ trace: [], output: 'looked around' })
    await run(browserExplore, { goal: 'browse', url: 'https://www.instagram.com/' })
    const task = await orchestrator.getActiveTask('sess-1')
    expect(task?.profileId).toBeTruthy()
    expect(provider.buGoals[0]).toContain('https://www.instagram.com/')
  })
})

describe('[COMP:sandbox/self-heal] BU trace → deterministic draft block (R2-5 v0)', () => {
  it('distills open/click/fill/send/done into governed runner code, sends staying terminal', () => {
    const { code, recording } = distillTrace({
      trace: DM_TRACE,
      goal: 'DM new followers',
      site: 'instagram.com',
    })
    expect(code).toContain('runner.open("https://www.instagram.com/")')
    expect(code).toContain('runner.click(runner.find("New follower Jane"))')
    expect(code).toContain('runner.fill(runner.find("Message"), "Thanks for the follow!")')
    expect(code).toContain('runner.submit(runner.find("Send"), "Send the DM")')
    expect(code).toContain('return "DM sent to Jane"')
    expect(recording.map((r) => r.action)).toEqual(['open', 'click', 'fill', 'submit', 'done'])

    const contract = extractEffectContract({ code, site: 'instagram.com' })
    expect(contract.flagged).toEqual([])
    expect(contract.terminalSends).toEqual([expect.objectContaining({ description: 'Send the DM' })])
  })

  it('the self-healed draft REPLAYS deterministically through runBrowserSkill (BU → deterministic)', async () => {
    const { provider, skillStore, profiles, orchestrator, browserExplore } = await build()
    provider.scriptBrowserUse({ trace: DM_TRACE, output: 'DM sent' })
    await run(browserExplore, {
      goal: 'DM new followers a thank-you note',
      url: 'https://www.instagram.com/',
      saveAs: 'dm-new-followers',
    })
    const draft = await skillStore.getByName({ workspaceId: 'ws-1', name: 'dm-new-followers' })
    expect(draft).toBeTruthy()

    // Replay: the deterministic runner accepts the draft; its terminal send
    // hits the gate (queues async - gated by default, R2-5).
    const approvals = createInMemoryBlockApprovals()
    const tools = createSkillRunnerTools({
      provider,
      binding: orchestrator.binding,
      skills: skillStore,
      approvals,
      profiles,
      approvalWaitMs: 300,
      pollMs: 5,
    })
    provider.scriptSkillRun(async (io) => {
      // Stand-in for the python replay reaching its submit step.
      io.writeFile('.runner/send-1.request.json', JSON.stringify({ n: 1, ref: '@e6', label: 'Send', description: 'Send the DM' }))
      for (let i = 0; i < 200; i++) {
        const d = io.readFile('.runner/send-1.decision.json')
        if (d) {
          io.writeFile('.runner/result.json', JSON.stringify({ ok: false, error: 'denied' }))
          return { stdout: '', stderr: '', exitCode: 1 }
        }
        await io.sleep(5)
      }
      return { stdout: '', stderr: '', exitCode: 1 }
    })
    const replay = await tools.runBrowserSkill.execute(
      tools.runBrowserSkill.inputSchema.parse({ skill: 'dm-new-followers' }) as never,
      toolContext({ sessionId: 'sess-2' }),
    )
    // The draft ran (not refused) and its send queued async - gated by default.
    expect([...approvals.rows.values()].some((r) => r.payload.skillName === 'dm-new-followers')).toBe(true)
    expect(replay.isError).toBe(true) // unanswered in this test - fail closed
  })
})
