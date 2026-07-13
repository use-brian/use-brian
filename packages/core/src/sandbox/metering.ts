/**
 * Computer-use COGS metering (§4.9): the three cost lines — model tokens,
 * sandbox-seconds, proxy-GB — all recorded through `usageStore.recordUsage`
 * into the SAME `usage_tracking` spine as every other cost, never a parallel
 * meter. Non-token lines use synthetic model ids (the same billing-id
 * pattern the Standard chat tier uses in model-resolution.ts): the unit
 * count rides the input-token column and the row's `actual_cost_usd`
 * carries the priced amount; `source` stays `'included'` (v1 is COGS-only,
 * not credit-debited).
 *
 * The per-session dollar cap (the `maxSpend` analog) accumulates on the
 * task row via the injected `addSpend`; a recording that crosses the task's
 * authorized budget reports `capExceeded` so the orchestrator fails the
 * task gracefully.
 *
 * Barrier 2 lives here too: `resolveUnattendedComputerUse` refuses to enable
 * the unattended acting path unless the meter is fully live.
 */
import { calculateCost, type UsageStore } from '../billing/cost-tracker.js'
import type { TokenUsage } from '../providers/types.js'
import type { SandboxTaskRecord } from './orchestrator.js'

/** Synthetic billing model ids — the line discriminators in usage_tracking. */
export const SANDBOX_SECONDS_MODEL = 'sandbox-seconds'
export const PROXY_GB_MODEL = 'proxy-gb'

/**
 * v1 unit rates. Sandbox-seconds tracks E2B's on-demand per-second price for
 * the default 1-vCPU class (~$0.10/hour); proxy-GB is the ballpark
 * residential-proxy rate, priced now so the recorder is real even while the
 * BYOP hook stays dormant (§4.6). Both are COGS knobs, not user prices —
 * revisit against the invoice once real traffic exists.
 */
export const SANDBOX_SECONDS_RATE_USD = 0.10 / 3600
export const PROXY_GB_RATE_USD = 10

export type SandboxMeterDeps = {
  /** The one spine. Null (OSS, no billing) → the meter is NOT active. */
  usageStore: UsageStore | null
  /**
   * Per-task spend accumulator (the closed `sandbox_tasks.spent_usd`
   * column, or an in-memory map in OSS/tests). Null → cap enforcement off.
   */
  addSpend:
    | ((taskId: string, usd: number) => Promise<{ spentUsd: number; authorizedBudgetUsd: number }>)
    | null
}

export type MeterRecordResult = { costUsd: number; capExceeded: boolean }

export type SandboxMeter = {
  /** True only when every line can actually record — Barrier 2's predicate. */
  meteringActive(): boolean
  recordSandboxSeconds(task: SandboxTaskRecord, seconds: number): Promise<MeterRecordResult>
  recordProxyGb(task: SandboxTaskRecord, gb: number): Promise<MeterRecordResult>
  /** Orchestrator-loop tokens on unattended runs (chat turns record via the chat route). */
  recordTokens(task: SandboxTaskRecord, model: string, usage: TokenUsage): Promise<MeterRecordResult>
}

export function createSandboxMeter(deps: SandboxMeterDeps): SandboxMeter {
  async function record(
    task: SandboxTaskRecord,
    row: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd: number; triggerKey: string },
  ): Promise<MeterRecordResult> {
    if (!deps.usageStore) return { costUsd: 0, capExceeded: false }
    await deps.usageStore.recordUsage({
      userId: task.userId,
      assistantId: '',
      workspaceId: task.workspaceId,
      sessionId: task.sessionId,
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      actualCostUsd: row.costUsd,
      source: 'included',
      triggerKey: row.triggerKey,
    })
    if (!deps.addSpend || row.costUsd <= 0) return { costUsd: row.costUsd, capExceeded: false }
    const { spentUsd, authorizedBudgetUsd } = await deps.addSpend(task.taskId, row.costUsd)
    return { costUsd: row.costUsd, capExceeded: spentUsd >= authorizedBudgetUsd }
  }

  return {
    meteringActive() {
      return deps.usageStore !== null
    },
    async recordSandboxSeconds(task, seconds) {
      const whole = Math.max(0, Math.round(seconds))
      if (whole === 0) return { costUsd: 0, capExceeded: false }
      return record(task, {
        model: SANDBOX_SECONDS_MODEL,
        inputTokens: whole,
        outputTokens: 0,
        costUsd: whole * SANDBOX_SECONDS_RATE_USD,
        triggerKey: 'computer_use:sandbox_seconds',
      })
    },
    async recordProxyGb(task, gb) {
      if (gb <= 0) return { costUsd: 0, capExceeded: false }
      // Unit column is integer — record megabytes for resolution.
      const mb = Math.max(1, Math.round(gb * 1024))
      return record(task, {
        model: PROXY_GB_MODEL,
        inputTokens: mb,
        outputTokens: 0,
        costUsd: gb * PROXY_GB_RATE_USD,
        triggerKey: 'computer_use:proxy_gb',
      })
    },
    async recordTokens(task, model, usage) {
      return record(task, {
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        costUsd: calculateCost(model, usage),
        triggerKey: 'computer_use:orchestrator',
      })
    },
  }
}

/** In-memory spend accumulator for OSS/tests (the closed impl is `sandbox_tasks.spent_usd`). */
export function createInMemorySpendAccumulator(defaultBudgetUsd: number): {
  addSpend: (taskId: string, usd: number) => Promise<{ spentUsd: number; authorizedBudgetUsd: number }>
  spent: Map<string, number>
} {
  const spent = new Map<string, number>()
  return {
    spent,
    async addSpend(taskId, usd) {
      const next = (spent.get(taskId) ?? 0) + usd
      spent.set(taskId, next)
      return { spentUsd: next, authorizedBudgetUsd: defaultBudgetUsd }
    },
  }
}

/**
 * Barrier 2 (§4.9, mirrors goals §4.13): the unattended acting path may only
 * enable when the deploy flag is on AND the meter is fully live. A
 * metering-absent boot yields `false` no matter what the env says.
 */
export function resolveUnattendedComputerUse(params: {
  flagEnabled: boolean
  meter: Pick<SandboxMeter, 'meteringActive'>
}): boolean {
  return params.flagEnabled && params.meter.meteringActive()
}
