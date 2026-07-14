/**
 * Non-blocking authoring advisories for a workflow definition. Unlike the
 * hard authoring checks (`dependencyIssues`, `pageAnchorIssues` — which
 * reject the save), these are heads-up warnings returned in the success
 * body so the author can act without being blocked.
 *
 * Shared by BOTH authoring surfaces: the REST create/update routes
 * (`packages/api/src/routes/workflows.ts`, surfaced as the web builder's
 * amber advisory block) and the chat-authoring `proposeWorkflow` tool
 * (`tools.ts`, folded into its `warnings`). It lives in core precisely so
 * the chat path cannot drift behind the REST path again — chat-authored
 * `researchMode: true` steps used to ship unwarned straight into the
 * deep-fan-out trap (the follow-up noted in
 * docs/architecture/features/workflow.md → "Non-blocking advisories").
 *
 * The two advisories, both born from the HKTV Mall prospect incidents:
 *
 * 1. `researchMode: true` — routes the step through the deep coordinator
 *    fan-out, whose protocol REQUIRES urlReader-backed evidence and DISCARDS
 *    webSearch-only findings (coordinator-pattern.md). For snippet-based /
 *    marketplace discovery the fan-out gathers nothing usable and the step
 *    fails `empty_response` (prod 2026-07-08, run 12abd640).
 *
 * 2. Evidence-heavy contact research on the DEFAULT budget — the reverse
 *    trap (prod 2026-07-08..13, fls.com.hk): a step demanding many verified
 *    contact fields ran on the default 10-tool-call consult budget,
 *    exhausted it mid-gather, and the forced synthesis invented the rest
 *    (now hard-blocked at the write boundary by the identifier-provenance
 *    gate, which turns the invention into "not verified" holes). The escape
 *    the author actually wants is `depth: { maxToolCalls, maxTurns,
 *    timeoutMs }` WITHOUT a tier: `resolveResearchBudget` applies numeric
 *    overrides tier-agnostically, and every deep-fan-out switch keys on
 *    `tier === 'deep'` alone — so a bare numeric `depth` buys real budget
 *    with none of the fan-out protocol.
 */

import type { WorkflowDefinition } from './types.js'

export type StepAdvisory = { path: Array<string | number>; message: string }

/** Contact/prospect research vocabulary — the field-demand half. */
const CONTACT_RESEARCH_KEYWORD =
  /\b(contact (?:info|information|details)|email address|e-mail|linkedin|instagram|decision.?maker|prospect|outreach list|phone number|social media (?:handle|account|profile)|founder|owner|point of contact)\b/i

/** Gathering verbs — the research-shaped half. Both halves must match. */
const RESEARCH_VERB = /\b(research|find|identify|discover|gather|collect|compile|look up|enrich|verify)\b/i

export function stepAdvisories(definition: WorkflowDefinition): StepAdvisory[] {
  const advisories: StepAdvisory[] = []
  for (const [i, step] of definition.steps.entries()) {
    if (step.type !== 'assistant_call') continue

    if (step.researchMode === true) {
      advisories.push({
        path: ['definition', 'steps', i],
        message: `Step "${step.id}" has research mode on. The deep research protocol requires urlReader-backed evidence and discards webSearch-only findings, so for snippet-based or marketplace discovery (e.g. listing shops from a storefront that cannot be opened page by page with urlReader) it often gathers nothing and fails the run with an empty response. If the sources cannot be read individually with urlReader, turn research mode off and set \`depth: { "maxToolCalls": 30, "maxTurns": 12, "timeoutMs": 240000 }\` on the step instead: a numeric depth raises the tool budget without switching the step into the deep fan-out protocol.`,
      })
      continue
    }

    const hasBudgetRaise =
      typeof step.depth?.maxToolCalls === 'number' || typeof step.depth?.maxTurns === 'number'
    const prompt = step.prompt ?? ''
    if (!hasBudgetRaise && CONTACT_RESEARCH_KEYWORD.test(prompt) && RESEARCH_VERB.test(prompt)) {
      advisories.push({
        path: ['definition', 'steps', i],
        message: `Step "${step.id}" looks like contact/prospect research but runs on the default consult budget (10 tool calls), which is rarely enough to verify multiple contact fields. Identifiers the step cannot verify in budget are reported as "not verified" rather than filled in (fabricated values are rejected at the record-write boundary). Give the step room to actually verify: set \`depth: { "maxToolCalls": 30, "maxTurns": 12, "timeoutMs": 240000 }\`. Do not use research mode for marketplace or storefront sources.`,
      })
    }
  }
  return advisories
}
