import { describe, it, expect } from 'vitest'
import {
  LAYER_1_SYSTEM_PROMPT,
  RESEARCH_MODE_ADDENDUM,
  FOLLOW_UP_QUESTIONS_ADDENDUM,
  COORDINATOR_BASE_ADDENDUM,
  COORDINATOR_RESEARCH_ADDENDUM,
} from '../system-prompt.js'

describe('[COMP:context-engine/layer-1-system-prompt] system-prompt constants', () => {
  it('LAYER_1_SYSTEM_PROMPT carries the base assistant identity and shipping rules', () => {
    expect(LAYER_1_SYSTEM_PROMPT).toContain('Use Brian')
    expect(LAYER_1_SYSTEM_PROMPT).toContain('How you use tools')
    expect(LAYER_1_SYSTEM_PROMPT).toContain('Two search attempts with no useful results = stop searching')
  })

  it('LAYER_1_SYSTEM_PROMPT extends honesty-about-what-you-see to operational self-state', () => {
    // Regression — 2026-06-15: the prod "Product" assistant confabulated a
    // "sleeping scheduler" root cause and asserted "no workflow runs executed"
    // without calling getWorkflowRun — contradicting 17 real runs. The honesty
    // section must cover claims about the assistant's OWN operation (run
    // history / status / analytics), not just files and URLs.
    expect(LAYER_1_SYSTEM_PROMPT).toContain('your own operation')
    expect(LAYER_1_SYSTEM_PROMPT).toContain('run history')
    expect(LAYER_1_SYSTEM_PROMPT).toMatch(/haven't checked/)
  })

  it('FOLLOW_UP_QUESTIONS_ADDENDUM is the opt-in chip-render block', () => {
    expect(FOLLOW_UP_QUESTIONS_ADDENDUM).toContain('<followup>')
    expect(FOLLOW_UP_QUESTIONS_ADDENDUM).toMatch(/2-4 questions/)
  })

  it('RESEARCH_MODE_ADDENDUM suspends the base "two searches and stop" rule', () => {
    expect(RESEARCH_MODE_ADDENDUM).toMatch(/two searches and stop.*suspended/i)
    expect(RESEARCH_MODE_ADDENDUM).toContain('depth is the product')
  })

  it('RESEARCH_MODE_ADDENDUM lists all five operating principles', () => {
    expect(RESEARCH_MODE_ADDENDUM).toContain('Brain-first')
    expect(RESEARCH_MODE_ADDENDUM).toContain('Parallelism')
    expect(RESEARCH_MODE_ADDENDUM).toContain('Triangulation')
    expect(RESEARCH_MODE_ADDENDUM).toContain('Never fabricate')
    expect(RESEARCH_MODE_ADDENDUM).toContain('Synthesize yourself')
  })

  it('RESEARCH_MODE_ADDENDUM keeps the multi-angle stop criterion', () => {
    expect(RESEARCH_MODE_ADDENDUM).toMatch(/3 distinct angles/)
  })

  it('RESEARCH_MODE_ADDENDUM routes ingestion to the right primitive, not loose saveMemory', () => {
    expect(RESEARCH_MODE_ADDENDUM).toContain('updateSelfProfile')
    expect(RESEARCH_MODE_ADDENDUM).toContain('saveContact')
    expect(RESEARCH_MODE_ADDENDUM).toContain('saveCompany')
    expect(RESEARCH_MODE_ADDENDUM).toContain('saveDeal')
    expect(RESEARCH_MODE_ADDENDUM).toMatch(/last resort/i)
  })

  it('RESEARCH_MODE_ADDENDUM defers tactical protocol to the coordinator addendum', () => {
    // The tactical 5-phase steps live in COORDINATOR_RESEARCH_ADDENDUM (this
    // module) — L1 just sets the principles. This deduplication keeps the
    // static research overhead small (~1KB instead of the prior ~3.6KB).
    expect(RESEARCH_MODE_ADDENDUM).toContain('coordinator-mode addendum')
    expect(RESEARCH_MODE_ADDENDUM.length).toBeLessThan(1500)
  })

  it('LAYER_1_SYSTEM_PROMPT extends "never ask for text confirmation" to brain saves', () => {
    // Regression — deadlock 2026-06-04: the model asked "Want this saved to the
    // brain?" in prose. The base rule must cover brain saves; the askQuestion-
    // not-prose routing lives in the coordinator addenda (kept out of L1 to
    // hold the fresh-user token budget — see prompt-token-cost.test.ts).
    expect(LAYER_1_SYSTEM_PROMPT).toContain('never ask for text confirmation')
    expect(LAYER_1_SYSTEM_PROMPT).toMatch(/Saving facts, research findings, or entities/)
    expect(LAYER_1_SYSTEM_PROMPT).toMatch(/Want this saved\?/)
  })

  it('COORDINATOR_RESEARCH_ADDENDUM routes questions through askQuestion, never prose', () => {
    // Regression — deadlock 2026-06-04. A prose question is invisible to the
    // query loop; only askQuestion is terminal + answerable.
    expect(COORDINATOR_RESEARCH_ADDENDUM).toMatch(/askQuestion tool, never prose/)
    expect(COORDINATOR_RESEARCH_ADDENDUM).toMatch(/Don't pre-empt Phase 4/)
    expect(COORDINATOR_RESEARCH_ADDENDUM).toMatch(/Save without asking/)
    // The four-phase protocol is still intact.
    expect(COORDINATOR_RESEARCH_ADDENDUM).toContain('Phase 1 — recall')
    expect(COORDINATOR_RESEARCH_ADDENDUM).toContain('Phase 4 — ingest + reply')
  })

  it('COORDINATOR_BASE_ADDENDUM forbids prose questions while workers run', () => {
    expect(COORDINATOR_BASE_ADDENDUM).toContain('coordinator mode')
    expect(COORDINATOR_BASE_ADDENDUM).toMatch(/askQuestion as your sole action/)
    expect(COORDINATOR_BASE_ADDENDUM).toMatch(/never a plain-text question/i)
  })
})
