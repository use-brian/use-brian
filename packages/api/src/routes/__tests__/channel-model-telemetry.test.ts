// [COMP:api/codex-provider] Actual served-model telemetry survives absent billing.
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { describe, expect, it, vi } from 'vitest'

const pipelineSource = readFileSync(new URL('../channel-pipeline.ts', import.meta.url), 'utf8')
const tree = ts.createSourceFile('channel-pipeline.ts', pipelineSource, ts.ScriptTarget.Latest, true)
let telemetry = ''
function visit(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(tree) === 'usage' && node.thenStatement.getText(tree).includes("eventName: 'turn_completed'")) telemetry = node.getText(tree)
  ts.forEachChild(node, visit)
}
visit(tree)
if (!telemetry) throw new Error('Missing actual channel terminal telemetry')

describe('[COMP:api/codex-provider] channel model telemetry', () => {
  it.each(['platform', 'user'] as const)('records actual %s served model without an optional usage store', keySource => {
    const logEvent = vi.fn(), scope = {
      usageStore: undefined, analytics: { logEvent }, userId: 'actor', assistant: { id: 'assistant' }, session: { id: 'session' },
      channelType: 'fixture', logicalTier: 'pro', customLlmRuntime: { providerKeySource: keySource, fallback: { used: false } },
      usage: { inputTokens: 2, outputTokens: 3, calculatedCostUsd: 0.1 },
      event: { response: { model: 'actual-served-model', stopReason: 'end_turn' } },
      calculateCost, sanitizeAnalytics: (value: unknown) => value,
    }
    new Function(...Object.keys(scope), ts.transpileModule(telemetry,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(scope))
    expect(logEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventName: 'turn_completed',
      metadata: expect.objectContaining({ model: 'actual-served-model', input_tokens: 2, output_tokens: 3, cost_usd_micro: keySource === 'user' ? 0 : 100_000 }) }))
  })
})
