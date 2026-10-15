/**
 * Configured-provider collection adapter for research comparison
 * (features/research.md -> "Eval CLI").
 *
 * Runs one research case through an injected runner (the eval script binds
 * it to the real query loop with the configured provider), observes it with the same research turn observer the
 * product uses, and records the resolved model, tool availability, budget,
 * sources, artifact outcome, cost and latency. It never decides whether to
 * run: `collectResearchTrace` requires the preflight and an explicit
 * confirmation first.
 *
 * [COMP:evals/research-comparison]
 */
import {
  RESEARCH_MODE_ADDENDUM,
  ASSISTANT_CALL_DEFAULT_BUDGET,
  resolveResearchBudget,
  type QueryEvent,
  type Tool,
  type TokenUsage,
} from '@use-brian/core'
import { createResearchTurnObserver } from '../../research/delivery.js'
import type { ResearchCase, ResearchCollectionAdapter, ResearchTrace } from './comparison.js'

const URL_RE = /https?:\/\/[^\s)\]"'<>]+/g

/** Runs one research turn and streams its events; returns the turn's total usage. */
export type ResearchCaseRunner = (input: {
  caseId: string
  systemPrompt: string
  prompt: string
  tools: Map<string, Tool>
  maxTurns: number
  onEvent: (event: QueryEvent) => void
}) => Promise<{ usage: TokenUsage | null }>

export function createConfiguredProviderCollectionAdapter(deps: {
  run: ResearchCaseRunner
  model: string
  tools: Map<string, Tool>
  engine: { id: string; version: string; config?: Record<string, unknown> }
  /** Existing metering: returns the cost of one usage record, or null when unknown. */
  costOf: (model: string, usage: TokenUsage) => number | null
  now?: () => number
}): ResearchCollectionAdapter {
  const now = deps.now ?? (() => Date.now())
  // The existing deep research tier: no fresh per-case budget is invented.
  const budget = resolveResearchBudget({ tier: 'deep' }, ASSISTANT_CALL_DEFAULT_BUDGET)
  return {
    identity: {
      engine: { id: deps.engine.id, version: deps.engine.version, config: { ...deps.engine.config, maxTurns: budget.maxTurns, maxToolCalls: budget.maxToolCalls } },
      runtime: { model: deps.model, tools: [...deps.tools.keys()].sort() },
    },
    async runCase(c: ResearchCase): Promise<ResearchTrace['results'][number]> {
      const missing = c.requirements.tools.filter((t) => !deps.tools.has(t))
      const base = { claims: [], readSources: [], citedSources: [], coverage: [], savedArtifact: { claimed: false, verified: false },
        unauthorizedAccess: false, usefulness: null, humanCorrections: null }
      if (missing.length) return { caseId: c.id, status: 'unavailable', ...base, costUsd: null, latencyMs: null }
      const observer = createResearchTurnObserver()
      const started = now()
      let text = ''
      let usage: TokenUsage | null = null
      const context = [c.context.projectBrief, ...c.context.priorArtifacts].filter(Boolean).join('\n\n')
      try {
        const out = await deps.run({
          caseId: c.id,
          systemPrompt: RESEARCH_MODE_ADDENDUM,
          prompt: context ? `${context}\n\n${c.request}` : c.request,
          tools: deps.tools,
          maxTurns: budget.maxTurns,
          onEvent: (event) => {
            observer.observe(event)
            if (event.type === 'text_delta') text += event.text
          },
        })
        usage = out.usage
      } catch {
        return { caseId: c.id, status: 'error', ...base, costUsd: null, latencyMs: now() - started }
      }
      const snap = observer.snapshot()
      const byRef = new Map(c.sources.filter((s) => s.ref).map((s) => [s.ref!, s.id]))
      const cited = [...new Set(text.match(URL_RE) ?? [])]
      return {
        caseId: c.id,
        status: 'completed',
        claims: [],
        readSources: snap.sources.filter((s) => s.inspected).map((s) => byRef.get(s.ref) ?? s.ref),
        citedSources: cited.map((u) => byRef.get(u) ?? u),
        coverage: c.expected.coverage.filter((term) => text.toLowerCase().includes(term.toLowerCase())),
        savedArtifact: { claimed: /\bsaved\b/i.test(text), verified: snap.receipts.length > 0 },
        unauthorizedAccess: false,
        usefulness: null,
        humanCorrections: null,
        costUsd: usage ? deps.costOf(deps.model, usage) : null,
        latencyMs: now() - started,
      }
    },
  }
}
