/** Automatic chat research limits. [COMP:workers/research-effort] */
export type ResearchEffort = 'focused' | 'standard' | 'deep'

export const RESEARCH_EFFORT_BUDGETS = {
  focused: { maxConcurrent: 2, maxWaves: 1, maxTurns: 30, maxToolCalls: 16, workerTurns: 12, workerToolCalls: 16 },
  standard: { maxConcurrent: 3, maxWaves: 2, maxTurns: 60, maxToolCalls: 28, workerTurns: 20, workerToolCalls: 28 },
  deep: { maxConcurrent: 5, maxWaves: 4, maxTurns: 200, maxToolCalls: 200, workerTurns: 30, workerToolCalls: 40 },
} as const

export function researchEffort(value: unknown): ResearchEffort {
  return value === 'focused' || value === 'deep' ? value : 'standard'
}

/** Trusted coordinator context, never user-facing response text. */
export function researchEffortInstruction(effort: ResearchEffort): string {
  const budget = RESEARCH_EFFORT_BUDGETS[effort]
  return `Research effort: ${effort}. Use at most ${budget.maxConcurrent} concurrent workers and ${budget.maxWaves} worker-result waves. These are ceilings, not targets. Start independent angles in parallel. Before delegation, check whether existing evidence already answers the request. After each wave, reassess whether further research is necessary and likely to add material evidence. Stop and synthesize as soon as evidence is sufficient. At the wave limit, synthesize with honest gaps instead of spawning more workers. This effort limit takes precedence over general instructions requiring follow-up waves.`
}
