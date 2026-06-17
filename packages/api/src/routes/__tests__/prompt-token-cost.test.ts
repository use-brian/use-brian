/**
 * Per-turn input token cost — regression benchmark + report.
 *
 * Scenarios and measurement live in `../_token-cost-scenarios.ts` so
 * this file and the `pnpm token-report` CLI stay in lockstep. See the
 * header of that module for what's real vs approximate.
 *
 * Purpose of this test:
 * - Regression guard: each scenario asserts total-token bounds. A
 *   change that meaningfully shifts a number trips a bound and the
 *   author must update it in the same commit.
 * - Structural guard: a few asserts check that specific prompt blocks
 *   actually render (e.g., retrieval-storm footer, episodic-before-topic
 *   ordering) — these catch wiring bugs that a pure size check misses.
 * - Visibility: `afterAll` prints the measurement table so every
 *   `pnpm test` run leaves the numbers on screen.
 *
 * # When a bound fails
 *
 * If the change is intentional, update the bound in the same commit
 * with a one-line comment explaining why. Then regenerate the
 * committed snapshot via `pnpm token-report` and include it in the
 * same commit.
 */

import { describe, it, expect, afterAll } from 'vitest'
import {
  scenarios,
  measureScenario,
  renderAsciiTable,
  LAYER_1_TOKENS,
  LAYER_1_CHARS,
  type Measurement,
} from '../_token-cost-scenarios.js'

const results: Measurement[] = []

function run(id: string): Measurement {
  const s = scenarios.find((x) => x.id === id)
  if (!s) throw new Error(`Scenario not found: ${id}`)
  const m = measureScenario(s)
  results.push(m)
  return m
}

afterAll(() => {
  // Emit once at the end so the output is a single contiguous block
  // rather than interleaved with other tests' stdout.
  // eslint-disable-next-line no-console
  console.log([
    '',
    '══════════════════════════════════════════════════════════════════════',
    '  Per-turn input token cost (approximation: chars ÷ 3.5)',
    '  Real tool schemas via Zod→JSON transform; real buildFullSystemPrompt.',
    '══════════════════════════════════════════════════════════════════════',
    renderAsciiTable(results),
    '',
    `  Layer 1 baseline: ${LAYER_1_TOKENS} tokens (${LAYER_1_CHARS} chars).`,
    '  Production truth lives in usageMetadata.promptTokenCount —',
    '  treat the numbers above as proxies, not invoices.',
    `  Regenerate the committed snapshot: \`pnpm --filter @sidanclaw/api token-report\`.`,
    '',
  ].join('\n'))
})

// ── Scenarios ────────────────────────────────────────────────────

describe('[COMP:prompt/token-cost] Per-turn input token cost — realistic user scenarios', () => {
  it('fresh user (no memories, no connectors, no custom instructions)', () => {
    const m = run('fresh')
    // Observed baseline: prompt ~2,600 + base tools ~1,014.
    // `createBaseTools()` returns the core-package subset (~8 tools);
    // route-layer additions (scheduling, workers, cache, files, bug)
    // aren't exercised here — real production adds ~800 more tokens.
    // 2026-04-23: bumped 2_800 → 3_400 for Layer 1's new "Relative time
    // discipline" section (~125 tokens, tightened from the initial draft).
    // The extra budget also covers the follow-on index-line changes that
    // render a `| YYYY-MM-DD` staleness tag in populated scenarios. See
    // 2026-04-23 Cynthia incident in
    // `docs/architecture/context-engine/layer-1-system-prompt.md`.
    // 2026-04-26: bumped 3_400 → 3_500 for the "# Follow-up questions"
    // block added in commit fb17ff3 (~27 tokens). The block instructs the
    // assistant to emit a <followup>[…]</followup> tag that the frontend
    // strips and renders as suggestion chips. See
    // docs/architecture/features/follow-up-questions.md.
    // 2026-05-29: bumped 3_500 → 3_800 — Layer-1 prompt growth (fresh-user
    // baseline measured at ~3695).
    // 2026-06-16: bumped 3_800 → 4_000 — Layer-1 gained (a) the operational-
    // self-state honesty rule (claims about your own runs / history / status
    // must come from a tool result this turn, not memory or a plausible theory
    // — the confabulation fix) and (b) the unified workflow-trigger vocabulary
    // ("scheduled job" removed from the model surface; scheduling is a workflow
    // trigger). Fresh-user baseline measured at ~3930.
    expect(m.promptTokens).toBeLessThan(4_000)
    expect(m.promptTokens).toBeGreaterThan(2_000)
    expect(m.totalTokens).toBeGreaterThan(2_800)
    expect(m.totalTokens).toBeLessThan(6_000)
  })

  it('light user (~10 memories, Calendar connector, no skills)', () => {
    const m = run('light')
    expect(m.totalTokens).toBeGreaterThan(4_500)
    expect(m.totalTokens).toBeLessThan(12_000)
  })

  it('active user (200 memories, Calendar + Gmail + Tasks, skills)', () => {
    const m = run('active')
    expect(m.totalTokens).toBeGreaterThan(6_000)
    expect(m.totalTokens).toBeLessThan(16_000)
    // Retrieval-storm guard wiring: if the footer disappears, the cap
    // has been silently re-enabled without the "N more memories" hint.
    expect(m.systemPrompt).toContain('125 more memories stored')
  })

  it('power user (1,000 memories, Google suite + GitHub + Notion + custom MCP, all behind mcp_search/mcp_call)', () => {
    const m = run('power')
    // PR #4 shipped — tool schemas no longer inlined. The 6,379 floor
    // represents the post-refactor cost: prompt + base tools + the
    // 2 gateway tools' descriptions (which list every connector + tool
    // count so the model can search without round-tripping). Upper
    // bound at 9,000 leaves headroom for the model-routing description
    // strings the gateways carry; trip it to investigate.
    expect(m.totalTokens).toBeGreaterThan(5_500)
    expect(m.totalTokens).toBeLessThan(9_000)
    expect(m.systemPrompt).toContain('925 more memories stored')
    // The model sees only 2 connector tools regardless of how many
    // providers are connected — that's the whole point of the refactor.
    expect(m.toolCount).toBeLessThan(20)
  })

  it('PR #4 savings — power-legacy baseline still measurable for A/B comparison', () => {
    const m = run('power-legacy')
    // PRE-PR#4 baseline kept so anyone comparing "before vs after"
    // can read the saving directly off the snapshot. At lock time
    // (2026-05-25): power-legacy total = ~11,634 tokens; power total =
    // ~6,379 tokens; saved per turn = ~5,255 tokens (~45%).
    expect(m.totalTokens).toBeGreaterThan(9_000)
    expect(m.totalTokens).toBeLessThan(14_000)
    // Compare against `power` for the documented saving.
    const post = results.find((r) => r.id === 'power')
    if (post) {
      const saved = m.totalTokens - post.totalTokens
      expect(saved).toBeGreaterThan(3_000) // floor — savings must be real
    }
  })

  it('team user (personal + team memories + Calendar)', () => {
    const m = run('team')
    expect(m.totalTokens).toBeGreaterThan(4_000)
    expect(m.totalTokens).toBeLessThan(12_000)
    expect(m.systemPrompt).toContain('## Team Context')
    expect(m.systemPrompt).toContain('## Your Name')
  })

  it('group-chat turn — adds group-chat block', () => {
    const m = run('group-chat')
    expect(m.systemPrompt).toContain('# Group chat')
    expect(m.totalTokens).toBeLessThan(10_000)
  })

  it('reply-context turn — adds reply block', () => {
    const m = run('reply-context')
    expect(m.systemPrompt).toContain('# Reply context')
    expect(m.systemPrompt).toContain('you (the assistant)')
    expect(m.totalTokens).toBeLessThan(10_000)
  })

  it('resume-topic turn — episodic history + topic hint', () => {
    const m = run('resume-topic')
    // Episodic must precede the topic hint so "above" resolves.
    const epIdx = m.systemPrompt.indexOf('# Relevant topic history')
    const topicIdx = m.systemPrompt.indexOf('# Current topic')
    expect(epIdx).toBeGreaterThan(0)
    expect(topicIdx).toBeGreaterThan(epIdx)
    expect(m.totalTokens).toBeLessThan(10_000)
  })
})
