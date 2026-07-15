/**
 * The governed logic-block runner (R2-1/R2-2/R2-5/R2-9/R2-10): every terminal
 * send a block reaches goes through the host-side gate — rehearsal stubs it,
 * a grant auto-approves it WITH an audit row, drift voids the grant, the verb
 * ceiling never auto-approves, and everything else queues async. Read-only
 * blocks run with zero human touch; several matching profiles force a name.
 */
import { describe, it, expect } from 'vitest'
import { createSkillRunnerTools } from '../skill-runner.js'
import { extractEffectContract } from '../effect-contract.js'
import {
  createInMemoryBlockApprovals,
  createInMemoryBrowserSkillGrantStore,
  createInMemoryBrowserSkillStore,
} from '../browser-skills.js'
import {
  createInMemoryBrowserProfileStore,
  createInMemorySessionVault,
} from '../profiles.js'
import {
  createInMemorySandboxTaskStore,
  createSandboxOrchestrator,
} from '../orchestrator.js'
import { StubSandboxProvider, type StubSkillRunIo } from '../providers/stub.js'
import type { ToolContext } from '../../tools/types.js'
import { sendDecisionPath, sendRequestPath, RESULT_PATH } from '../runner-shim.js'
import type { BlockSendDecision } from '../runner-shim.js'

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

const SENDING_CODE = `
def run(runner, params):
    runner.open("https://www.instagram.com/")
    runner.snapshot()
    runner.submit("@e6", "Send DM to a new follower")
`

const READ_ONLY_CODE = `
def run(runner, params):
    runner.open("https://www.instagram.com/")
    runner.snapshot()
    return "collected"
`

/** A scripted "running block": emits one send request, obeys the decision. */
function oneSendScript(request: { ref?: string; label?: string; description?: string; drift?: string }) {
  return async (io: StubSkillRunIo) => {
    io.writeFile(sendRequestPath(1), JSON.stringify({ n: 1, ...request }))
    for (let i = 0; i < 800; i++) {
      const text = io.readFile(sendDecisionPath(1))
      if (text) {
        const decision = JSON.parse(text) as BlockSendDecision
        if (decision.stub) {
          io.writeFile(
            RESULT_PATH,
            JSON.stringify({ ok: true, summary: 'rehearsed', wouldSend: [{ ref: request.ref, description: request.description }] }),
          )
          return { stdout: 'stubbed', stderr: '', exitCode: 0 }
        }
        if (decision.approved) {
          io.writeFile(RESULT_PATH, JSON.stringify({ ok: true, summary: 'sent it' }))
          return { stdout: 'sent', stderr: '', exitCode: 0 }
        }
        io.writeFile(RESULT_PATH, JSON.stringify({ ok: false, error: `denied: ${decision.reason ?? ''}` }))
        return { stdout: '', stderr: 'denied', exitCode: 1 }
      }
      await io.sleep(5)
    }
    return { stdout: '', stderr: 'no decision', exitCode: 1 }
  }
}

function readOnlyScript() {
  return async (io: StubSkillRunIo) => {
    io.writeFile(RESULT_PATH, JSON.stringify({ ok: true, summary: 'collected 3 items' }))
    return { stdout: '', stderr: '', exitCode: 0 }
  }
}

async function build(opts: { profiles?: Array<{ name: string; backend?: 'local' | 'cloud' }> } = {}) {
  const provider = new StubSandboxProvider()
  const taskStore = createInMemorySandboxTaskStore()
  const vault = createInMemorySessionVault()
  const profileStore = createInMemoryBrowserProfileStore()
  const skillStore = createInMemoryBrowserSkillStore()
  const grantStore = createInMemoryBrowserSkillGrantStore()
  const approvals = createInMemoryBlockApprovals()
  const orchestrator = createSandboxOrchestrator({ provider, taskStore, vault, profileStore })

  const created: Record<string, { id: string }> = {}
  for (const p of opts.profiles ?? [{ name: 'Personal IG' }]) {
    created[p.name] = await profileStore.create({
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      name: p.name,
      defaultBackend: p.backend ?? 'cloud',
      enabledAssistantIds: ['asst-1'],
    })
  }

  const tools = createSkillRunnerTools({
    provider,
    binding: orchestrator.binding,
    skills: skillStore,
    grants: grantStore,
    approvals,
    profiles: { store: profileStore, vault, assistantClearance: async () => 'confidential' },
    approvalWaitMs: 1_500,
    pollMs: 5,
  })

  async function addSkill(name: string, code: string) {
    return skillStore.create({
      workspaceId: 'ws-1',
      name,
      site: 'instagram.com',
      code,
      contract: extractEffectContract({ code, site: 'instagram.com' }),
      recording: [{ step: 1, action: 'open', url: 'https://www.instagram.com/' }],
      origin: 'assistant',
    })
  }

  return { provider, orchestrator, vault, profileStore, skillStore, grantStore, approvals, tools, addSkill, profiles: created }
}

async function run(tool: { execute: (i: never, c: ToolContext) => Promise<{ data: unknown; isError?: boolean; meta?: Record<string, unknown> }>; inputSchema: { parse: (i: unknown) => unknown } }, input: Record<string, unknown>, ctx = toolContext()) {
  return tool.execute(tool.inputSchema.parse(input) as never, ctx)
}

describe('[COMP:sandbox/skill-runner] runBrowserSkill routes every terminal send through the gate (R2-9)', () => {
  it('an un-granted send QUEUES async and fires only after the human approves — no bypass', async () => {
    const { provider, approvals, tools, addSkill } = await build()
    await addSkill('dm-followers', SENDING_CODE)
    provider.scriptSkillRun(oneSendScript({ ref: '@e6', label: 'Send', description: 'Send DM to a new follower' }))

    const running = run(tools.runBrowserSkill, { skill: 'dm-followers' })
    // The gate parks the send as a pending approval before anything fires.
    let pendingId: string | null = null
    for (let i = 0; i < 200 && !pendingId; i++) {
      await new Promise((r) => setTimeout(r, 5))
      for (const [id, row] of approvals.rows) {
        if (row.status === 'pending') pendingId = id
      }
    }
    expect(pendingId).toBeTruthy()
    const parked = approvals.rows.get(pendingId!)!
    expect(parked.payload).toMatchObject({ skillName: 'dm-followers', site: 'instagram.com' })

    approvals.respond(pendingId!, 'approved')
    const result = await running
    expect(result.isError ?? false).toBe(false)
    expect(String(result.data)).toContain('sent it')
    expect(String(result.data)).toContain('approved by the user')
  })

  it('a denied send stops the block — the click never fires', async () => {
    const { provider, approvals, tools, addSkill } = await build()
    await addSkill('dm-followers', SENDING_CODE)
    provider.scriptSkillRun(oneSendScript({ ref: '@e6', description: 'Send DM' }))

    const running = run(tools.runBrowserSkill, { skill: 'dm-followers' })
    let pendingId: string | null = null
    for (let i = 0; i < 200 && !pendingId; i++) {
      await new Promise((r) => setTimeout(r, 5))
      for (const [id, row] of approvals.rows) if (row.status === 'pending') pendingId = id
    }
    approvals.respond(pendingId!, 'rejected')
    const result = await running
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('denied')
  })

  it('an unanswered send fails closed at the wait deadline and stays parked in Approvals', async () => {
    const { provider, approvals, tools, addSkill } = await build()
    await addSkill('dm-followers', SENDING_CODE)
    provider.scriptSkillRun(oneSendScript({ ref: '@e6', description: 'Send DM' }))
    const result = await run(tools.runBrowserSkill, { skill: 'dm-followers' })
    expect(result.isError).toBe(true)
    const statuses = [...approvals.rows.values()].map((r) => r.status)
    expect(statuses).toContain('expired')
  })

  it('read-only blocks run unattended with ZERO human touch (the 1984 case, R2-5)', async () => {
    const { provider, approvals, tools, addSkill } = await build()
    await addSkill('collect-feed', READ_ONLY_CODE)
    provider.scriptSkillRun(readOnlyScript())
    const result = await run(tools.runBrowserSkill, { skill: 'collect-feed' })
    expect(result.isError ?? false).toBe(false)
    expect(String(result.data)).toContain('collected 3 items')
    expect(approvals.rows.size).toBe(0) // nothing queued, nothing audited
  })

  it('rehearsal STUBS the terminal send — "would send", nothing fires, no approvals touched (R2-5)', async () => {
    const { provider, approvals, grantStore, tools, addSkill, profiles } = await build()
    const skill = await addSkill('dm-followers', SENDING_CODE)
    // Even WITH a grant in place, rehearsal never consults or spends it.
    await grantStore.create({
      workspaceId: 'ws-1',
      skillId: skill.id,
      profileId: profiles['Personal IG'].id,
      grantedBy: 'user-1',
    })
    provider.scriptSkillRun(oneSendScript({ ref: '@e6', description: 'Send DM to a new follower' }))
    const result = await run(tools.runBrowserSkill, { skill: 'dm-followers', rehearsal: true })
    expect(result.isError ?? false).toBe(false)
    expect(String(result.data)).toContain('Would send')
    expect(String(result.data)).toContain('Send DM to a new follower')
    expect(approvals.rows.size).toBe(0)
    expect([...grantStore.grants.values()][0].lastUsedAt).toBeNull()
  })

  it('a FLAGGED contract refuses to run at all (fail-closed authoring gate)', async () => {
    const { tools, skillStore } = await build()
    const code = 'import subprocess\n\ndef run(runner, params):\n    subprocess.run(["agent-browser", "click", "@e1"])\n'
    await skillStore.create({
      workspaceId: 'ws-1',
      name: 'evil',
      site: 'instagram.com',
      code,
      contract: extractEffectContract({ code, site: 'instagram.com' }),
      recording: [],
      origin: 'external',
    })
    const result = await run(tools.runBrowserSkill, { skill: 'evil' })
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('flagged')
  })
})

describe('[COMP:sandbox/approval-grants] Grants auto-approve with an audit row; drift voids (R2-2)', () => {
  it('a satisfied block+profile grant auto-approves the send AND writes an auto_approved audit row', async () => {
    const { provider, approvals, grantStore, tools, addSkill, profiles } = await build()
    const skill = await addSkill('dm-followers', SENDING_CODE)
    const grant = await grantStore.create({
      workspaceId: 'ws-1',
      skillId: skill.id,
      profileId: profiles['Personal IG'].id,
      grantedBy: 'user-1',
    })
    provider.scriptSkillRun(oneSendScript({ ref: '@e6', label: 'Send', description: 'Send DM to a new follower' }))
    const result = await run(tools.runBrowserSkill, { skill: 'dm-followers' })
    expect(result.isError ?? false).toBe(false)
    expect(String(result.data)).toContain('auto-approved')
    const audits = [...approvals.rows.values()].filter((r) => r.status === 'auto_approved')
    expect(audits).toHaveLength(1)
    expect(audits[0].grantId).toBe(grant.id)
    expect(audits[0].payload).toMatchObject({ skillName: 'dm-followers', profileName: 'Personal IG' })
  })

  it('DRIFT voids the grant and re-gates the send async (R2-2)', async () => {
    const { provider, approvals, grantStore, tools, addSkill, profiles } = await build()
    const skill = await addSkill('dm-followers', SENDING_CODE)
    const grant = await grantStore.create({
      workspaceId: 'ws-1',
      skillId: skill.id,
      profileId: profiles['Personal IG'].id,
      grantedBy: 'user-1',
    })
    provider.scriptSkillRun(
      oneSendScript({ ref: '@e9', description: 'Send DM', drift: 'unresolved ref @e9 (not in the latest snapshot)' }),
    )
    const running = run(tools.runBrowserSkill, { skill: 'dm-followers' })
    let pendingId: string | null = null
    for (let i = 0; i < 200 && !pendingId; i++) {
      await new Promise((r) => setTimeout(r, 5))
      for (const [id, row] of approvals.rows) if (row.status === 'pending') pendingId = id
    }
    expect(pendingId).toBeTruthy() // re-gated despite the grant
    expect(grantStore.grants.get(grant.id)?.status).toBe('voided')
    approvals.respond(pendingId!, 'rejected')
    const result = await running
    expect(result.isError).toBe(true)
  })

  it('the VERB CEILING is never grant-satisfiable: a payment send queues for a human even when granted (R2-1)', async () => {
    const { provider, approvals, grantStore, tools, addSkill, profiles } = await build()
    const skill = await addSkill('dm-followers', SENDING_CODE)
    await grantStore.create({
      workspaceId: 'ws-1',
      skillId: skill.id,
      profileId: profiles['Personal IG'].id,
      grantedBy: 'user-1',
    })
    provider.scriptSkillRun(oneSendScript({ ref: '@e6', label: 'Pay now', description: 'Confirm the payment' }))
    const running = run(tools.runBrowserSkill, { skill: 'dm-followers' })
    let pendingId: string | null = null
    for (let i = 0; i < 200 && !pendingId; i++) {
      await new Promise((r) => setTimeout(r, 5))
      for (const [id, row] of approvals.rows) if (row.status === 'pending') pendingId = id
    }
    expect(pendingId).toBeTruthy()
    expect(approvals.rows.get(pendingId!)!.payload.ceiling).toBe('payment')
    // No auto_approved audit row: the grant was never consulted.
    expect([...approvals.rows.values()].filter((r) => r.status === 'auto_approved')).toHaveLength(0)
    approvals.respond(pendingId!, 'approved')
    const result = await running
    expect(result.isError ?? false).toBe(false)
  })
})

describe('[COMP:sandbox/logic-block] The block artifact carries its review artifacts (R2-5)', () => {
  it('stores code + contract + recording, versioning on update', async () => {
    const { skillStore, addSkill } = await build()
    const skill = await addSkill('dm-followers', SENDING_CODE)
    expect(skill.contract.terminalSends).toHaveLength(1)
    expect(skill.recording).toHaveLength(1)
    expect(skill.version).toBe(1)
    const updated = await skillStore.update(skill.id, { description: 'hardened' })
    expect(updated?.version).toBe(2)
  })
})

describe('[COMP:sandbox/runner-shim] The governed shim protocol (R2-9)', () => {
  it('generates a shim whose ONLY terminal verb handshakes through request/decision files', async () => {
    const { buildRunnerShimSource, sendRequestPath, sendDecisionPath } = await import('../runner-shim.js')
    const source = buildRunnerShimSource({ sendTimeoutSeconds: 60 })
    // submit writes the request, polls the decision, and NEVER clicks unapproved.
    expect(source).toContain('def submit(ref, description=None):')
    expect(source).toContain('send-%d.request.json')
    expect(source).toContain('send-%d.decision.json')
    expect(source).toContain('raise RunnerDenied')
    // The stub path records "would send" instead of firing (rehearsal).
    expect(source).toContain('_would_send.append')
    expect(sendRequestPath(3)).toBe('.runner/send-3.request.json')
    expect(sendDecisionPath(3)).toBe('.runner/send-3.decision.json')
  })
})

describe('[COMP:sandbox/verb-ceiling] The hardcoded never-auto verbs (R2-1)', () => {
  it('matches the five ceiling classes and nothing benign', async () => {
    const { checkVerbCeiling } = await import('../verb-ceiling.js')
    expect(checkVerbCeiling({ description: 'Wire the funds to the vendor' })?.reason).toBe('financial_transfer')
    expect(checkVerbCeiling({ label: 'Delete my account' })?.reason).toBe('account_deletion')
    expect(checkVerbCeiling({ description: 'Confirm the payment' })?.reason).toBe('payment')
    expect(checkVerbCeiling({ description: 'Reset the password' })?.reason).toBe('security_settings')
    expect(checkVerbCeiling({ description: 'Delete all drafts' })?.reason).toBe('mass_delete')
    expect(checkVerbCeiling({ description: 'Send DM to a new follower', label: 'Send' })).toBeNull()
  })
})

describe('[COMP:sandbox/skill-runner] Profile at call time (R2-10) + backends + gates', () => {
  it('several enabled+cleared profiles force the model to NAME one', async () => {
    const { provider, tools, addSkill } = await build({
      profiles: [{ name: 'Personal IG' }, { name: 'Company IG' }],
    })
    await addSkill('collect-feed', READ_ONLY_CODE)
    const ambiguous = await run(tools.runBrowserSkill, { skill: 'collect-feed' })
    expect(ambiguous.isError).toBe(true)
    expect(String(ambiguous.data)).toContain('Personal IG')
    expect(String(ambiguous.data)).toContain('Company IG')

    provider.scriptSkillRun(readOnlyScript())
    const named = await run(tools.runBrowserSkill, { skill: 'collect-feed', profile: 'Company IG' })
    expect(named.isError ?? false).toBe(false)
    expect(named.meta?.profile).toBe('Company IG')
  })

  it('runs AS the profile: the profile\'s vault bundle injects into the task sandbox', async () => {
    const { provider, vault, tools, addSkill, profiles } = await build()
    await vault.put({
      profileId: profiles['Personal IG'].id,
      site: 'instagram.com',
      bundle: { site: 'instagram.com', cookies: [{ name: 'ig' }], capturedAt: new Date().toISOString() },
    })
    await addSkill('collect-feed', READ_ONLY_CODE)
    provider.scriptSkillRun(readOnlyScript())
    const result = await run(tools.runBrowserSkill, { skill: 'collect-feed' })
    expect(result.isError ?? false).toBe(false)
    const [sbx] = [...provider.sandboxes.values()]
    expect(sbx.injectedBundles.map((b) => b.site)).toEqual(['instagram.com'])
    expect(sbx.skillRuns).toHaveLength(1)
  })

  it('a local-default profile gets an honest mismatch error (blocks run in the cloud sandbox)', async () => {
    const { tools, addSkill } = await build({ profiles: [{ name: 'LinkedIn me', backend: 'local' }] })
    await addSkill('collect-feed', READ_ONLY_CODE)
    const result = await run(tools.runBrowserSkill, { skill: 'collect-feed' })
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('cloud')
  })

  it('refuses on autonomous paths unless unattended is enabled AND the plan is paid (R2-8)', async () => {
    const { tools, addSkill } = await build()
    await addSkill('collect-feed', READ_ONLY_CODE)
    const off = await run(tools.runBrowserSkill, { skill: 'collect-feed' }, toolContext({ channelType: 'workflow' }))
    expect(off.isError).toBe(true)
    expect(String(off.data)).toContain('autonomous')
  })

  it('listBrowserSkills + listBrowserProfiles give the model its discovery surface', async () => {
    const { tools, addSkill } = await build({ profiles: [{ name: 'Personal IG' }] })
    await addSkill('dm-followers', SENDING_CODE)
    await addSkill('collect-feed', READ_ONLY_CODE)
    const skills = await run(tools.listBrowserSkills, {})
    expect(String(skills.data)).toContain('dm-followers')
    expect(String(skills.data)).toContain('approval-gated')
    expect(String(skills.data)).toContain('collect-feed')
    expect(String(skills.data)).toContain('read-only')

    const profiles = await run(tools.listBrowserProfiles, {})
    expect(String(profiles.data)).toContain('Personal IG')
    expect(String(profiles.data)).toContain('[usable]')
  })

  it('an EMPTY profile list never reads as "browsing is blocked" (2026-07-15 refusal source)', async () => {
    const { tools } = await build({ profiles: [] })
    const profiles = await run(tools.listBrowserProfiles, {})
    expect(profiles.isError ?? false).toBe(false)
    expect(String(profiles.data)).toContain('does NOT block browsing')
    expect(String(profiles.data)).toContain('browserNavigate')
  })
})
