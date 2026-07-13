import { describe, it, expect } from 'vitest'
import {
  createSandboxMeter,
  createInMemorySpendAccumulator,
  resolveUnattendedComputerUse,
  SANDBOX_SECONDS_MODEL,
  PROXY_GB_MODEL,
  SANDBOX_SECONDS_RATE_USD,
  PROXY_GB_RATE_USD,
} from '../metering.js'
import { createSandboxOrchestrator, createInMemorySandboxTaskStore, type SandboxTaskRecord } from '../orchestrator.js'
import { createCloudBrowserProvider } from '../cloud-browser-provider.js'
import { StubSandboxProvider } from '../providers/stub.js'
import { createComputerTools } from '../tools.js'
import type { UsageStore } from '../../billing/cost-tracker.js'

type RecordedRow = {
  model: string
  inputTokens: number
  outputTokens: number
  actualCostUsd: number
  source: string
  triggerKey?: string
  workspaceId?: string
  userId: string
  sessionId: string | null
}

function fakeUsageStore(): UsageStore & { rows: RecordedRow[] } {
  const rows: RecordedRow[] = []
  return {
    rows,
    async recordUsage(params) {
      rows.push(params as unknown as RecordedRow)
    },
    async getWeeklyCost() {
      return 0
    },
    async getEarliestChargeAfter() {
      return null
    },
    async getSessionCostUsd() {
      return 0
    },
    async getAssistantWeeklyCost() {
      return 0
    },
    async getAssistantModelMix() {
      return []
    },
    async getAssistantDailyTrend() {
      return []
    },
  }
}

const TASK: SandboxTaskRecord = {
  taskId: 'task-1',
  sandboxId: 'sbx-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  status: 'running',
  profileId: null,
  injectedSite: null,
  authorizedBudgetUsd: 2,
  createdAt: 0,
  lastActivityAt: 0,
}

describe('[COMP:sandbox/metering] Three COGS lines on the usage_tracking spine (§4.9)', () => {
  it('records sandbox-seconds as a synthetic-model row: units in the token column, priced cost, included source', async () => {
    const usage = fakeUsageStore()
    const meter = createSandboxMeter({ usageStore: usage, addSpend: null })
    await meter.recordSandboxSeconds(TASK, 120)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      model: SANDBOX_SECONDS_MODEL,
      inputTokens: 120,
      outputTokens: 0,
      actualCostUsd: 120 * SANDBOX_SECONDS_RATE_USD,
      source: 'included',
      triggerKey: 'computer_use:sandbox_seconds',
      workspaceId: 'ws-1',
      userId: 'user-1',
      sessionId: 'sess-1',
    })
  })

  it('records proxy-GB the same way (dormant BYOP hook, real recorder)', async () => {
    const usage = fakeUsageStore()
    const meter = createSandboxMeter({ usageStore: usage, addSpend: null })
    await meter.recordProxyGb(TASK, 0.5)
    expect(usage.rows[0]).toMatchObject({
      model: PROXY_GB_MODEL,
      inputTokens: 512, // MB for integer resolution
      actualCostUsd: 0.5 * PROXY_GB_RATE_USD,
      source: 'included',
      triggerKey: 'computer_use:proxy_gb',
    })
  })

  it('records orchestrator tokens through the same spine with real model pricing', async () => {
    const usage = fakeUsageStore()
    const meter = createSandboxMeter({ usageStore: usage, addSpend: null })
    await meter.recordTokens(TASK, 'gemini-3.5-flash', { inputTokens: 1000, outputTokens: 500 })
    expect(usage.rows[0]).toMatchObject({
      model: 'gemini-3.5-flash',
      inputTokens: 1000,
      outputTokens: 500,
      source: 'included',
      triggerKey: 'computer_use:orchestrator',
    })
    expect(usage.rows[0].actualCostUsd).toBeGreaterThan(0)
  })

  it('accumulates task spend and reports the per-session cap crossing', async () => {
    const usage = fakeUsageStore()
    const { addSpend } = createInMemorySpendAccumulator(0.005)
    const meter = createSandboxMeter({ usageStore: usage, addSpend })
    const first = await meter.recordSandboxSeconds(TASK, 60)
    expect(first.capExceeded).toBe(false)
    const second = await meter.recordSandboxSeconds(TASK, 3600)
    expect(second.capExceeded).toBe(true)
  })
})

describe('[COMP:sandbox/metering] Per-session dollar cap bounds a live task (§4.9)', () => {
  it('a task that crosses its authorized budget is failed mid-flight, sandbox killed', async () => {
    const usage = fakeUsageStore()
    const provider = new StubSandboxProvider()
    const taskStore = createInMemorySandboxTaskStore()
    let t = 1_000_000
    const { addSpend } = createInMemorySpendAccumulator(0.001) // ~36 sandbox-seconds
    const meter = createSandboxMeter({ usageStore: usage, addSpend })
    const orchestrator = createSandboxOrchestrator({ provider, taskStore, meter, now: () => t })
    const browser = createCloudBrowserProvider({ provider, binding: orchestrator.binding })
    const ctx = { userId: 'u', workspaceId: 'w', sessionId: 's' }

    await browser.navigate(ctx, 'https://example.com/')
    const task = await orchestrator.getActiveTask('s')

    t += 10 * 60 * 1000 // ten minutes of sandbox time >> the authorized budget
    const err = await browser.snapshot(ctx).catch((e: unknown) => e)
    expect(String((err as Error).message)).toMatch(/authorized budget|stopped/)
    expect(provider.sandboxes.get(task!.sandboxId)?.status).toBe('killed')
    expect(await orchestrator.getActiveTask('s')).toBeNull()
    // The spend that crossed the cap is still recorded on the spine.
    expect(usage.rows.some((r) => r.model === SANDBOX_SECONDS_MODEL)).toBe(true)
  })
})

describe('[COMP:sandbox/metering] Barrier 2 — metering-absent boot cannot enable unattended (§4.9)', () => {
  it('the flag alone is not enough: no usage store → unattended stays off', () => {
    const dark = createSandboxMeter({ usageStore: null, addSpend: null })
    expect(resolveUnattendedComputerUse({ flagEnabled: true, meter: dark })).toBe(false)

    const live = createSandboxMeter({ usageStore: fakeUsageStore(), addSpend: null })
    expect(resolveUnattendedComputerUse({ flagEnabled: true, meter: live })).toBe(true)
    expect(resolveUnattendedComputerUse({ flagEnabled: false, meter: live })).toBe(false)
  })

  it('the tool layer honors the resolved gate end-to-end on a headless channel', async () => {
    const provider = new StubSandboxProvider()
    const local = createLocalStub()
    const dark = createSandboxMeter({ usageStore: null, addSpend: null })
    const tools = createComputerTools({
      local,
      cloud: createCloudBrowserProvider({ provider, binding: null }),
      unattendedEnabled: () =>
        resolveUnattendedComputerUse({ flagEnabled: true, meter: dark }),
    })
    const res = await tools.browserSnapshot.execute(
      {},
      {
        userId: 'u',
        assistantId: 'a',
        sessionId: 's',
        appId: 'app',
        channelType: 'workflow',
        channelId: 'c',
        workspaceId: 'w',
        abortSignal: new AbortController().signal,
      },
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('autonomous')
  })
})

function createLocalStub() {
  return {
    kind: 'local' as const,
    navigate: async (_c: unknown, url: string) => ({ url }),
    snapshot: async () => ({ url: '', title: '', nodes: [] }),
    click: async () => {},
    type: async () => {},
    currentUrl: async () => ({ url: '', title: '' }),
    stop: async () => {},
  }
}
