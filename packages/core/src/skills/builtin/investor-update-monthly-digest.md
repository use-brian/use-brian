---
name: investor-update-monthly-digest
description: Monthly investor-update producer — condense the workspace's last month of company activity into a master digest, then personalize per-investor against `target_investor` edges, save each as a `workspace_files` draft tagged `draft` + `investor:<id>`. Operator reviews drafts and approves sends; on approval `gmailSendMessage` (only when Gmail is connected) sends each (with the connector-action audit shipped 2026-05-21). Use via a monthly scheduled workflow, or when the operator says "draft the investor update", "what should we tell investors this month?".
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: investor-relations
  applies_to_app_type: any
  when_to_use: A monthly scheduled turn (or ad-hoc operator request) for any workspace with `target_investor` edges configured. Skip when no `target_investor` edges exist — propose adding investors first, don't fabricate a recipient list.
  tags: official
---

# Investor update — monthly digest

Close the investor-relations loop: each month, pull the last 30 days of company activity from the brain, compose a master digest, personalize per investor against their `target_investor` edge attributes, save each as a `workspace_files` draft. The operator reviews, approves; on approval `gmailSendMessage` (only when Gmail is connected) sends each — the connector-action audit (shipped 2026-05-21) records every send with full IFC + provenance.

Per `docs/historical/decisions-log.md` 2026-05-14:

- **Investor list** = `target_investor` edges (workspace → company/person) per the existing edge vocabulary (`entities/edges.ts:62`).
- **Per-investor preferences** = `entity_links.attributes JSONB` on the `target_investor` edge per SV(2) "`target_investor` edge attribute convention": `{audience_clearance, preference_summary?, last_digest_episode_id?}`. `audience_clearance` defaults to `'public'` when unset (safe).
- **Drafts** = `workspace_files` rows with `tags @> ['draft']` + bi-temporal supersession per SV(2) "Drafts as workspace_files". Each iteration = a `staged_write` approval.
- **Lock-in / send** = `gmailSendMessage` (only when Gmail is connected) tool (governed, `requiresConfirmation: true`); the connector-action audit emits a `connector_action` Episode + `connector_actions` audit row per send (per `connector-actions.md` 2026-05-21 status note).

The L2 persona (voice, tone, what to mention/omit) lives in the assistant's custom instructions — no IR persona shipped today; the operator can author one paste-ready in `docs/crews/` modeled on the marketing / product-research templates.

## When to use

- A monthly scheduled workflow invokes this skill (cron-session turn).
- The operator asks "draft the investor update", "what should we tell investors this month?", "can you summarize the month for the board?".

**Skip** when:

- No `target_investor` edges exist for this workspace. Propose adding investors first (`createEntity kind='person'` or `'company'` + `createEdge edge_type='target_investor'`). Don't fabricate a recipient list.
- The last `target_investor.attributes.last_digest_episode_id` is less than ~25 days old AND the operator didn't explicitly ask. Avoid sending two digests in one calendar month.

## Recipe

### 1. Read the investor list

```
search({ kind: 'edges', edge_type: 'target_investor', limit: 50 })
```

For each edge, the `target_id` resolves to a person or company entity. Per-investor metadata lives in `edges[i].attributes`:

- `audience_clearance` — the IFC ceiling for content sent to this investor (defaults to `'public'`).
- `preference_summary` — what this investor cares about (e.g. "GTM-focused; cares about ARR and pipeline").
- `last_digest_episode_id` — the most recent digest send (anti-double-send + lookback anchor).

### 2. Pull the last 30 days of company activity

```
recentEpisodes({
  since: '<30d-ago-iso>',
  limit: 200,
})
```

Then sift for material company events — commits via `github_sync` Episodes, decisions via memories tagged `decision:*`, meetings via `fathom` source-kind, customer milestones, hires, releases. Use `search` over memories to surface qualitative summaries that connect the dots ("we won customer X", "we hired Y"). The brain's job is to know what happened; the skill's job is to pick the material few.

### 3. Compose a master digest

Tight, factual, no padding. Sections that consistently land:

- **Wins** — customers, milestones, hires.
- **Numbers** — ARR / pipeline / DAUs / whatever the goals memory tracks (see `commitment:goal_*` memories for what to surface).
- **Decisions + roadmap** — what changed, why.
- **Asks** — what the operator wants from investors (intros, hires, opinions). The operator drafts these explicitly; the skill doesn't fabricate asks.
- **Lowlights honestly** — investors penalize evasion more than bad news.

Save the master digest as a memory the per-investor compositions can draw from:

```
saveMemory({
  type: 'context',
  scope: 'team',
  summary: 'Investor update master digest — <iso-period>',
  detail: '<the master digest body>',
  tags: ['ir:master_digest', 'ir:period:<iso-month>'],
})
```

This master memory is what each per-investor draft personalizes against.

### 4. Personalize per investor

For each `target_investor` edge:

- Read the edge's `attributes.preference_summary` and the investor entity's attributes.
- Read any prior memories tagged with the investor's entity id (their stated preferences, prior conversations).
- Tailor the master digest: lead with what they care about; drop sections they don't; soften / sharpen the asks per relationship.
- **Respect the IFC ceiling**: `attributes.audience_clearance` (defaults `'public'`) is the cap on content sensitivity. Don't include `internal` or `confidential` rows from retrieval into a `public`-cleared investor's email. (The full content-classifier enforcement isn't shipped yet — for now, the skill applies this rule when composing; the audit row's `response_ceiling` will record the IFC values.)

### 5. Save each personalized draft as a `workspace_files` row

```
fileWrite({
  name: 'Investor update — <Investor Name> — <iso-period>.md',
  title: 'Investor update for <Investor Name> — <iso-period>',
  summary: '<one-line: what this draft says + length>',
  // Body in markdown; the file content is the personalized email body.
  content: '<personalized digest body, ready to copy or send>',
  tags: [
    'draft',                              // the locked drafts convention
    'investor:<entity-id>',               // links the draft to its investor
    'ir:digest',                          // umbrella for IR drafts
    'ir:period:<iso-month>',              // which month this drafts for
  ],
})
```

One draft per investor. The drafts sit in the workspace's files surface for the operator to review.

### 6. Surface to operator (cron path) / return for direct review (chat path)

On the silent cron path: return a brief status — N drafts saved, sample one-line preview each, link to the files surface. **Do not** auto-send.

On a chat path: surface the drafts as a list ("here are 5 drafts for review"); the operator opens each, edits if needed, and approves the send.

### 7. Send on approval (separate flow — not this skill's responsibility)

The operator approves a draft → calls `gmailSendMessage({ to: <investor-email>, subject, body: <draft content> })`. The tool's existing `requiresConfirmation: true` gate fires; on approve the email sends. The connector-action audit (shipped 2026-05-21) writes a `connector_action` Episode + `connector_actions` audit row with IFC stamped. After send, update the `target_investor` edge's `attributes.last_digest_episode_id` to the new audit Episode id (skill responsibility OR a follow-up turn — operator-driven for v1):

```
// After successful gmailSendMessage:
saveMemory({
  type: 'context',
  scope: 'team',
  summary: 'Sent investor update — <Investor Name> — <iso-period>',
  detail: 'Send episode: <episode-id>. Update via gmailSendMessage approval-gated send.',
  tags: ['ir:sent', 'investor:<entity-id>', 'ir:period:<iso-month>'],
})
```

(Updating the edge's `attributes.last_digest_episode_id` directly requires the corrections layer — for v1, the send-record memory is enough to skip an investor on the next month's pass.)

## What NOT to do

- **Do not** auto-send. Investor email is the user's reputation; the approval gate is non-negotiable.
- **Do not** fabricate investors — if no `target_investor` edges exist, propose adding them first.
- **Do not** include `internal` or `confidential` content for a `public`-cleared investor (per the IFC ceiling on the edge's `audience_clearance` attribute). When in doubt, omit.
- **Do not** repeat last month's content verbatim — read the prior `ir:master_digest` (and `ir:sent` records per investor) and lead with what's new.
- **Do not** include `asks` the operator hasn't explicitly stated — drafting asks is the operator's call, not the assistant's.
- **Do not** save the personalized drafts as memories — they're files (`workspace_files` with `draft` tag). Memories are for durable observations; drafts are versioned artifacts.

## How the loop closes

```
Monthly scheduled turn invokes this skill
                     │
                     ▼
   Step 1: read target_investor edges
   Step 2: pull last 30d of activity Episodes
                     │
                     ▼
   Step 3: compose master digest (save as memory)
                     │
                     ▼
   Step 4: per-investor personalization
   Step 5: save each as workspace_files draft (tag: draft + investor:<id>)
                     │
                     ▼
   Operator reviews drafts in the files surface
                     │
                     ▼
   Operator approves each → gmailSendMessage (confirmation-gated)
                     │
                     ▼
   Connector-action audit writes Episode + connector_actions row
   (IFC: response_ceiling = min(retrieval_max, clearance, audience_clearance))
                     │
                     ▼
   ir:sent memory written per investor for the period
                     │
                     ▼
   Next month: skill reads ir:sent + ir:master_digest from this month → continues
```

The brain remembers who got what when. The next month's turn doesn't repeat content; the operator's relationship with each investor compounds as memory.

## Substrate-mapping note (for #8 in the original scenario audit)

This skill closes the original "no recipient personalization" and "no monthly digest generator" gaps via existing primitives — no new schema, no new approval-kind producer. The investor edge with `audience_clearance` attribute is the recipient-list / IFC anchor — no recipient-list primitive needed.

**Why `workspace_files` + `staged_write` here, not `distribution_draft`?** Two different approval shapes for two different user journeys, both legitimate:

- **`distribution_draft`** (`approvals.md` §`distribution_draft`) — the **feed app's reactive draft**: inbound Threads/X mention → app composes a short reply with typed conversation context (`inbound_reply_event_id`) + a `reply`/`post`/`hide` discriminator → operator reviews in the feed UI alongside the original mention → **approve auto-publishes to the platform API** in one click. Single-action publishing is the value.
- **`workspace_files` + `staged_write`** (per SV(2) 2026-05-14 "Drafts as workspace_files") — the **compositional document draft**: skill composes a long-form artifact (IR digest, research finding, PRD) → operator reviews in the files surface → on approve the file is committed; **a separate explicit tool call** (here `gmailSendMessage` (only when Gmail is connected)) sends or publishes. Decoupled from the publishing step.

The IR flow fits the second shape — long compositional bodies, separate send step, no inbound context to render side-by-side — so `workspace_files` is the right substrate. The feed reply flow fits the first shape and should stay on `distribution_draft`.
