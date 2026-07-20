---
name: product-research-daily-check
description: Periodic product-research turn — read research goals + the workspace's target_competitor edges + prior findings, scan the landscape for what changed, save findings as memories, optionally iterate the active research draft. Use via a scheduled workflow (weekly / biweekly), or when the operator asks "any moves from competitors?", "what's new in <space>?", "anything to update on the roadmap?".
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: research
  applies_to_app_type: any
  when_to_use: A scheduled turn for any workspace running periodic landscape / competitor research (memory tag `commitment:goal_research_*`). Also valid as an ad-hoc operator query. Skip when no research goals are configured — propose creating one first, don't fabricate scope.
  tags: official
---

# Product research daily check

Periodic landscape / competitor / ecosystem research turn. Reads the workspace's research goals (`commitment:goal_research_*` memories), competitor watchlist (`target_competitor` edges), and prior findings → does the research per goal scope → saves new findings as memories → optionally iterates the active research draft (`workspace_files` tagged `draft`). The next turn picks up where this one left off via retrieval over the saved memories — that's the moat working as designed.

Per `docs/historical/decisions-log.md` 2026-05-14:

- **Goals** = memories tagged `commitment:open` + `commitment:goal_research_<kind>` scoped `(NULL, assistant_id)` (workspace-shared) per entry 23.
- **Competitor watchlist** = `target_competitor` edges (workspace → company/person), with `attributes JSONB` carrying per-competitor metadata per entry 24 + the `target_competitor` attributes shape in `edges.ts:231`.
- **Findings** = regular `type: 'context'` memories tagged `research:finding` (+ optional `competitor:<entity-id>` / `theme:<slug>` for grouping).
- **Active draft (PRD, deep-dive doc)** = a `workspace_files` row with `tags @> ['draft']` + bi-temporal supersession per SV(2) entry "Drafts as workspace_files". Substantive edits go through `staged_write` approvals. Lock-in (when the founder commits the draft to GitHub) is handled by the separate `finalizeProduct` workflow — not this skill.

This skill is the model-side runbook. The L2 persona (voice, signal filter, opinion model) lives in the assistant's custom instructions — see `docs/crews/product-research-assistant-prompt.md` for a paste-ready template.

## When to use

- A weekly / biweekly scheduled workflow invokes this skill (cron-session turn).
- The operator asks "any competitor moves?", "what's new in <space>?", "anything I should know about <competitor>?".

**Skip** when:

- No `commitment:goal_research_*` memories exist for this workspace. Propose creating at least one ("what space are you tracking — competitors, dependencies, a roadmap idea?"). Don't fabricate scope.
- No `target_competitor` edges and no theme-scope hints in the goals. There's nothing to research against. Ask the operator to add at least one competitor or theme.

## Recipe

### 1. Read research goals

```
searchMemory({
  tags: ['commitment:open', 'commitment:goal_research'],
  limit: 10,
})
```

Or query a specific kind (e.g. `commitment:goal_research_competitive`, `commitment:goal_research_pricing`, `commitment:goal_research_dependencies`). Each goal's `summary` + `detail` carries the scope and target ("Maintain feature parity with X, Y, Z", "Track the dependency tree for breaking changes monthly").

### 2. Read the competitor watchlist

The `target_competitor` edge sources from the workspace and targets a `company` or `person` entity. Walk it with `search` over edges:

```
search({ kind: 'edges', edge_type: 'target_competitor', limit: 50 })
```

For each target, fetch the entity to know its current state and any per-target attributes on the edge (positioning, pricing tier, etc.):

```
getEntity({ id: <target-entity-id> })
```

If no `target_competitor` edges exist but the goals carry theme hints (e.g. "track memory-system advances"), use those as scope.

### 3. Read prior findings (to avoid re-surfacing)

```
searchMemory({ tags: ['research:finding'], limit: 50 })
```

The persona's hard rule: "if it's been pitched or rejected, skip it or explain what changed." Check the prior findings before proposing a feature idea.

### 4. Do the research

Use the assistant's available tools to scan the landscape — `mcp_search` over connectors / inspiration tools / web search (if connected). Constrained to the goal scope from step 1. For each scope item, ask: what changed since the last cycle? What's a recurring user complaint Use Brian's architecture could solve? Any pricing / distribution / policy shifts?

Skip noise per the L2 persona: funding rounds without a product delta, generic AI news, benchmark releases, things already decided on.

### 5. Save new findings as memories

For each genuinely new signal:

```
saveMemory({
  type: 'context',
  scope: 'team',
  summary: '<one-line signal: who did what, why it matters>',
  detail: '<full context + source URL + how it relates to the goal>',
  tags: [
    'research:finding',
    'competitor:<entity-id>',       // when tied to a specific competitor
    'theme:<slug>',                 // when tied to a theme (memory-systems, pricing, mcp, etc.)
    'goal:<commitment-id>',         // backlink to the goal that motivated the finding
  ],
})
```

For findings that propose a roadmap action (a feature idea, a pricing move), include the "why Use Brian is uniquely positioned" + an effort tier in the detail.

### 6. Optionally iterate the active research draft

If a `workspace_files` row exists for the topic with `tags @> ['draft']`, this turn MAY propose substantive additions to it via the `staged_write` approval surface (the operator reviews + approves the supersession; `workspace_files` supports bi-temporal supersession per migration 128). Tag the new file row `draft` + the topic slug (`prd:<slug>` etc.). **Do not** edit drafts silently — the staged_write approval gate is the operator's check.

If no active draft exists for the topic and the operator hasn't asked for one, **don't create one**. Drafts get created when the founder explicitly wants to iterate toward lock-in (which then runs through the separate `finalizeProduct` workflow).

### 7. Return a brief status per the persona's digest format

If invoked by an operator query:

- **What changed** — 3-5 bullets. What, who, why it matters. Source link each.
- **Feature suggestions** — 1-3 ideas: problem → proposal → why Use Brian is uniquely positioned → effort tier (days/weeks/months).
- **Open questions** — things you couldn't resolve.

Under ~500 words. Nothing changed? Say so in one line. Ad-hoc questions get direct answers, no digest framing.

On the silent cron path, the saved memories **are** the output — no chat reply.

## What NOT to do

- **Do not** fabricate research goals — ask the operator to create one if none exist.
- **Do not** save findings without source links in `detail` — the persona's hard rule. Speculation should be labeled "Guessing —".
- **Do not** include the L2 voice / opinion model in this skill — that's the assistant's custom instructions (`docs/crews/product-research-assistant-prompt.md`).
- **Do not** edit a `draft` workspace_file silently — substantive edits go through `staged_write` approvals.
- **Do not** trigger `finalizeProduct` from this skill — lock-in is the operator's explicit action through that separate workflow.
- **Do not** keyword-spam memory with `research:finding`-tagged paraphrases — the Light dedup phase will merge them but it's noisy. Save one finding per genuine signal.

## How the loop closes

```
Daily / weekly scheduled turn invokes this skill
                     │
                     ▼
   Step 1: read goals (commitment:goal_research_*)
   Step 2: read target_competitor edges + entities
   Step 3: read prior findings (research:finding-tagged memories)
                     │
                     ▼
   Step 4: scan landscape per scope
                     │
                     ▼
   Step 5: save new findings as memories
   Step 6: optionally propose draft additions via staged_write
                     │
                     ▼
   Next turn retrieves these findings (and prior ones) → reasons over them
                     │
                     ▼
   Eventually the founder locks the research as a product spec via
   the `finalizeProduct` workflow (separate orchestration — entity
   creation + documented_by edge + goal-closure + GitHub write).
```

Each turn reads its own past output. New findings dedup against prior ones via the consolidation worker (Light's tag-based Jaccard) so the index stays clean.
