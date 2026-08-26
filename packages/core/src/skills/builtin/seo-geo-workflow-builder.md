---
name: seo-geo-workflow-builder
description: Install the confirmed four-workflow portfolio SEO/GEO operator for usebrian.ai and studio.usebrian.ai, including Project scope, Search Console, exact SerpAPI measurement, AI answer engines, scorecards, action routing, and Slack notifications.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: research
  applies_to_app_type: any
  when_to_use: The user wants to install or revise the weekly portfolio SEO/GEO operating loop for usebrian.ai and studio.usebrian.ai. Gather and verify the non-secret inputs, show the exact cost and workflow shape, obtain explicit confirmation, then use the canonical workflow proposal flow.
  tags: official
---

# Portfolio SEO/GEO workflow installer

Install the complete portfolio operator. This is an interactive installer, not the weekly audit itself. Never run a paid panel during setup, never ask the user to paste a secret into chat, and never create or enable any workflow until the user has reviewed the cheap preflight and explicitly confirmed the cost and shape.

The install target is four workflows bound to the same immutable workspace Project, scorecard destination, and resolved Slack channel ID:

1. `Weekly Portfolio SEO/GEO`
2. `GEO Brian Action Executor`
3. `GEO Brian Task Notifier`
4. `GEO Brian Action Watchdog`

## Non-secret inputs to resolve

Gather these conversationally. Reuse an already verified value; do not repeatedly ask for it.

- The canonical active Project named exactly `GEO`. The current turn must be Project-bound, and the workflow proposal must report that immutable Project ID. Never emulate a Project with a `project:GEO` tag.
- One Search Console property copied verbatim from the connected account. It must cover both hosts without overlap. Do not add totals from a root property and an overlapping subdomain property.
- Primary host `usebrian.ai` and Studio host `studio.usebrian.ai`, their exact Search Console page/host filters, and priority URLs. The newest Search Console date is normally today minus three days and may never be newer than today minus two days.
- One saved scorecard page and one readable/writable scorecard blueprint. The page order is fixed by `seo-geo-audit`.
- Slack destination `#brian-marketing`. Resolve it by discovery and persist the exact `C...` or `G...` channel ID. Missing or ambiguous name resolution blocks installation. A name or internal UUID is not a Slack destination.
- Monday 09:00 in `Asia/Hong_Kong`, unless the user explicitly chooses another cadence or timezone.

If a connector/provider is missing, name only the missing configuration (`Google Search Console`, `SerpAPI`, `OpenAI engine`, `Gemini engine`, `Perplexity engine`, or `Slack`). Stop at that boundary so the user can configure it in the connector/settings UI. Never request, repeat, move, or store the secret value.

## Locked registry and panel shape

The registry is versioned as `portfolio-geo-v1`. Query keys and exact text are stable until a deliberate review mints a new registry version.

Primary, 12 weekly Google queries:

`U01 What is Use Brian?`
`U02 What is an AI company brain?`
`U03 Best AI company brain for small teams`
`U04 AI operating system for small businesses`
`U05 AI assistant that remembers company context`
`U06 AI workspace with memory and workflows`
`U07 Open-source company brain`
`U08 Self-hosted AI company brain`
`U09 AI assistant for Telegram Slack and web`
`U10 Automate business operations with an AI assistant`
`U11 Use Brian pricing`
`U12 Is Use Brian open source?`

Studio, 17 weekly Google queries:

`S01 What is AI operations consulting?`
`S02 What does an AI operations consultant do?`
`S03 Best AI operations consulting firm in Hong Kong`
`S04 AI automation consultant Hong Kong`
`S05 AI workflow automation consulting for small and mid-sized businesses`
`S06 How do I automate business operations with AI?`
`S07 AI operations audit for a company`
`S08 Enterprise AI implementation partner Hong Kong`
`S09 AI consulting for professional services firms Hong Kong`
`S10 Generative AI training for companies Hong Kong`
`S11 AI workshops for business teams Hong Kong`
`S12 On-premise private AI consulting Hong Kong`
`S13 AI consultant that audits, builds, and hands over workflows`
`S14 AI consulting firm that lets clients keep ownership of their systems`
`S15 What is Brian Studio?`
`S16 Is Brian Studio the services arm of Use Brian?`
`S17 Brian Studio pricing or consultation`

The weekly AI sample is exactly nine questions per site, one sample per question, on OpenAI, Gemini, and Perplexity. Use:

- Primary: U01, U11, U12, U03, U08, U09, U02, U05, U10.
- Studio: S15, S16, S17, S03, S04, S05, S01, S06, S12.

Set `checkFor` to the expected brand and canonical host, and cap answers at `answerMaxChars: 1200`. Claude is not part of the weekly run. It may be added only to a separately confirmed monthly/manual panel.

## Cheap cost and shape preflight

Before proposing a workflow, produce a compact confirmation card. This check must make no paid search/engine call.

The current checked-in provider rate-map snapshot is:

- SerpAPI: 29 successful units multiplied by `SEARCH_PROVIDER_COST_PER_1K.serpapi / 1000`.
- OpenAI: 18 successful units multiplied by `ENGINE_PROVIDER_COST_PER_1K.openai / 1000`.
- Gemini: 18 successful units multiplied by `ENGINE_PROVIDER_COST_PER_1K.gemini / 1000`.
- Perplexity: 18 successful units multiplied by `ENGINE_PROVIDER_COST_PER_1K.perplexity / 1000`.

At the current map this is `$0.725 + $0.990 + $0.810 + $0.090 = $2.615` per weekly run before Brian orchestration usage. Treat this as a synchronized rate-map snapshot, not vendor pricing truth. If the provider set, query count, sample count, or rates differ from this snapshot, recalculate the exact manifest and obtain a fresh confirmation. The contract test intentionally fails if the live checked-in maps and this snapshot drift.

Show all of the following and ask one explicit question: `Create these four Project-scoped workflows with an estimated external-provider cost of <amount> per weekly run?`

- Project name and immutable ID.
- GSC property and the two non-overlapping host/page filters.
- Registry version, 29 Google units, 54 AI units, and provider list.
- Scorecard page and blueprint.
- Resolved Slack channel name and ID.
- Weekly schedule and hourly watchdog schedule.
- Four workflow names, triggers, and concise step outlines.

Do not treat a generic earlier `continue`, a connector setup confirmation, or an approval of only one field as approval of this paid blueprint.

## Canonical definitions

Build with the standard workflow authoring tools. For each workflow, call the proposal tool, resolve every error and warning, present the exact returned proposal, then apply its opaque receipt only after the user confirms. Never reconstruct a receipt. The four workflows must remain bound to the active `GEO` Project when persisted.

### 1. Weekly Portfolio SEO/GEO

Trigger: weekly Monday at 09:00, `Asia/Hong_Kong`. Do not use trigger delivery sugar; the final step has an explicit Slack delivery. Set workflow-level `failureDelivery` to the resolved Slack channel ID.

Definition graph:

| Step | Type and required fields | Next |
|---|---|---|
| `gsc_sites` | when the GSC connector is connected, `tool_call` using `searchConsoleListSites`; store `gsc_sites`; otherwise installation is blocked | `cheap_preflight` |
| `cheap_preflight` | `assistant_call`, enforced `seo-geo-audit`, scorecard page anchor, only cheap/read tools; compare Project, exact GSC property, hosts/filters/registry, scorecard/blueprint, resolved Slack ID, and the installed cost manifest; output exactly `PASS` or a compact failure object | `preflight_gate` |
| `preflight_gate` | `branch`; true only when the preflight output is exactly `PASS` | true: `start_collectors`; false: `preflight_fail` |
| `preflight_fail` | when the GSC connector is connected, `tool_call` using `searchConsoleQuery` with a deliberately invalid property and no search/engine call; this must terminate the run so the workflow failure boundary posts the preflight failure | terminal |
| `start_collectors` | small `assistant_call` that emits the verified manifest unchanged | fan out to the five collectors below |
| `gsc_technical` | when the GSC connector is connected, `assistant_call`, enforced `seo-geo-audit`, grants only `searchConsoleQuery`, `searchConsoleInspectUrl`, and `searchConsoleListSitemaps`; collect 7/7 and 28/28 windows for both exact host filters, sitemap status, homepages, and rotating priority URLs; compact structured output | `portfolio_analysis` |
| `primary_google` | `tool_call` using exact `webSearch` with the 12 primary queries, `provider: "serpapi"`, `resultMode: "measurement"`, and both portfolio domains in `trackDomains` | `portfolio_analysis` |
| `studio_google` | same exact-provider call for the 17 Studio queries | `portfolio_analysis` |
| `primary_ai` | `assistant_call`, enforced `seo-geo-audit`, grants exactly `askOpenAI`, `askGemini`, and `askPerplexity`; nine primary questions, one sample, answer cap 1200 | `portfolio_analysis` |
| `studio_ai` | equivalent nine-question Studio panel | `portfolio_analysis` |
| `portfolio_analysis` | `assistant_call`, enforced `seo-geo-audit`; consume only compact collector outputs, required prior valid history, and compute deterministic coverage, ownership conflicts, persistence, and candidates | `record_scorecard` |
| `record_scorecard` | page-anchored `assistant_call`, enforced `seo-geo-audit`, scorecard blueprint, grants the anchored page/blueprint write tools; save the typed record and fixed-order human page, then read back; store `scorecard` | `route_actions` |
| `route_actions` | `assistant_call`, enforced `seo-geo-audit`, grants exactly the durable task read/write tools; deterministic-key upsert, no more than 8 mutations and no more than 3 new Brian tasks; failed run means zero mutations; store `actions` | `slack_summary` |
| `slack_summary` | `assistant_call` with explicit Slack `deliver` using the resolved channel ID; status/period/coverage, one-line per-site GSC/Google/AI movement, ownership findings, lane counts, blockers, and run/scorecard/task links | terminal |

The only fan-out is the five collector steps. Every branch rejoins at `portfolio_analysis`. Google calls are dedicated exact `tool_call` steps. AI and GSC assistant steps have explicit tool allow-lists plus the enforced audit skill. Do not concatenate raw snippets or complete AI answers into later prompts.

### 2. GEO Brian Action Executor

Trigger: task event, `fromBots: true`, lifecycle actions `created`, `tagged`, `updated`, and `reopened`; `match.tags` contains `geo:queued` and `match.currentTags` contains `geo:route:brian`. This requires the queue tag to be part of the firing mutation while the persistent route tag is present.

One `assistant_call` step targets the primary assistant, enforces `seo-geo-task-executor`, grants only durable task read/write tools plus the bounded tools needed by the task at runtime, and receives the live `{{input.event.taskId}}`. It claims, executes, verifies, and ends the task as `done` or `blocked`. Set workflow `failureDelivery` to the resolved Slack ID.

### 3. GEO Brian Task Notifier

Trigger: task event, `fromBots: true`, lifecycle actions `completed` or `blocked`, and `match.currentTags: ["geo:route:brian"]`. This is intentionally a persistent-current-tag filter, not `match.tags`.

One read-only `assistant_call` reads the live task and posts exactly one terminal message with an explicit Slack delivery:

- `COMPLETED`: site/category, result, verification, task link, and originating run.
- `BLOCKED`: site/category, blocker, work already completed, input/action required, task link, and originating run.

### 4. GEO Brian Action Watchdog

Trigger: hourly schedule in `Asia/Hong_Kong`. One `assistant_call` enforces `seo-geo-task-executor` and grants durable task reads/updates. It inspects Brian-routed tasks carrying `geo:queued` or `geo:running`, and changes one to `blocked` only when it has had no progress for more than two hours. It records the exact reason and required next input. The notifier handles Slack. Set workflow `failureDelivery` to the resolved Slack ID.

## Installation completion

After all four writes succeed, return their names, IDs, triggers, Project ID, scorecard destination, Slack channel ID, and whether each schedule is enabled. Do not run the paid panel. Recommend a manual cheap preflight and then a separately approved paid acceptance run after deployment. If any proposal or write fails, stop and report the exact workflow and validation error; never leave the user believing a partial install is complete.
