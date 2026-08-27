---
name: seo-geo-audit
description: Runtime contract for the two-site portfolio SEO/GEO audit: compact collection, coverage semantics, history comparison, scorecard structure, deterministic action routing, and Slack-ready summaries.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: research
  applies_to_app_type: any
  when_to_use: Enforced by the weekly portfolio SEO/GEO workflow while collecting, analyzing, recording, or routing results. Do not use this skill to install workflows or request credentials.
  tags: official
---

# Portfolio SEO/GEO audit runtime

Follow this contract only inside a workflow that grants the required tools. This skill does not install workflows and does not imply that any named integration is available. If a required tool is absent, return an attributable collector error; never improvise the result.

## Invariants

- Portfolio sites are `primary = usebrian.ai` and `studio = studio.usebrian.ai`.
- Registry version is `portfolio-geo-v1`: U01-U12 and S01-S17 from the installing workflow. Preserve key, exact question text, intent, owner, priority, cadence, and target URL. Never silently rewrite a query.
- Expected weekly paid units are 29 exact SerpAPI searches and 18 questions per AI provider across OpenAI, Gemini, and Perplexity. Samples equal one. Claude is absent.
- The workflow and every task/page write stay in the workflow's frozen Project. Never add a `project:GEO` tag.
- Evidence is compact. Keep ranked title/URL/domain rows, tracked-domain ranks, normalized metrics, citation/mention flags, capped excerpts or hashes, and attributable errors. Do not pass raw snippets, full answers, secrets, or provider payloads downstream.

## GSC and technical collection

Use the one canonical property verbatim. Split the two sites with their exact non-overlapping page/host filters. End the newest window at today minus three days unless the installed lag is higher; never use a lag below two days.

For each host collect the latest complete 7 days versus the preceding 7, and the latest complete 28 days versus the preceding 28. Record clicks, impressions, CTR, average position, top queries/pages with movement and new/lost entries, sitemap status, and URL inspection for the homepage plus the installed rotating priority URLs. Every row retains property, host filter, date window, and dimensions as provenance.

## Google and AI normalization

Google measurement is exact-provider SerpAPI. Preserve query order and provider provenance. An individual error stays as one attributable error row; do not replace it with another provider.

For every AI question/provider/sample record:

- completed or error;
- expected brand/domain mention;
- citation count and whether a portfolio domain is cited;
- answer position/order when detectable;
- materially wrong brand, product, relationship, pricing, or capability claims;
- competing entities/domains; and
- one capped evidence excerpt or hash.

Never treat an AI answer as deterministic rank truth. Perplexity calls are serialized by the collector policy and transient failures are bounded; do not add your own unbounded retry loop.

## Coverage and run status

Compute coverage from mandatory expected units, not from how many outputs happen to be nonempty:

`ratio = valid / expected`

- `complete`: every mandatory collector completed and `valid === expected`.
- `partial`: mandatory infrastructure completed, `ratio >= 0.80`, and at least one unit failed.
- `failed`: `ratio < 0.80`, canonical GSC/property preflight failed, required trend history was unreadable, or the scorecard write/read-back failed.

Only complete and partial runs enter trend history. Compare a partial run only against like-for-like valid units and label its coverage. A failed run records errors but mutates no action task. Never let a Slack delivery failure change the measurement status.

## Portfolio analysis

Analyze both site views and one portfolio view. `owner` is the expected winning site. A different portfolio domain winning a non-shared query is a cannibalization/ownership conflict, not a win for both. A shared query may record a shared win. Separate observed technical defects and materially wrong AI claims from ordinary visibility opportunities.

Before changing tasks, emit candidates with exactly:

`issueKey, site, category, severity, evidence, persistenceCount, route, title, objective, doneWhen, dependencies`

Allowed values:

- site: `primary | studio | shared`
- category: `technical | brand | content | citation | accuracy | measurement`
- severity: `high | medium | low`
- route: `brian | coding | human`

Evidence includes run ID, period, query keys, and compact metrics. Sort candidates by severity, persistence, then estimated impact.

## Persistence and deterministic task routing

Ordinary opportunities require the same issue on two consecutive valid runs. A directly observed technical defect or materially wrong claim may route on its first valid run. Failed/incomplete evidence creates no opportunity task.

Upsert by deterministic `issueKey`. Before creating, list the matching key tag, forward-resolve its current live task ID, and update that task. Reopen a completed issue only after two new consecutive valid runs show regression. Close only after two consecutive valid recovered runs. The run may mutate at most 8 tasks and create at most 3 new Brian-routed tasks; record excess candidates as deferred.

Every action task has:

- `geo:action`;
- exactly one route tag: `geo:route:brian`, `geo:route:coding`, or `geo:route:human`;
- exactly one site tag: `geo:site:primary`, `geo:site:studio`, or `geo:site:shared`;
- one deterministic `geo:key:<slug>` tag, total tag length at most 64;
- Brian work starts with `geo:queued`; coding work has `handoff:ready`; human work has `needs:human`.

Do not add a Project tag. The Project is the write context.

### Brian route

Use only for bounded, reversible workspace work that the granted runtime tools can complete and verify: drafts, research, internal scorecard/page updates, and similar low-risk actions. The description contains Objective, Evidence, Allowed actions, Done when, and Links. Never route source-code changes, deploys, publishing, indexing requests, outreach, secrets, external approvals, or unbounded spend to Brian.

### Coding route

Do not execute it here. Write a direct coding-agent handoff containing Outcome, Evidence/reproducible symptom, Constraints/non-goals, high-level implementation surfaces without invented filenames, Acceptance checks, and expected verification commands. Never include secrets, production IDs, full provider payloads, or an instruction to deploy.

### Human route

Write Decision/action needed, Why a human is required, Evidence, Exact steps, and Completion signal. Use this lane for secrets/access, indexing, product/brand/pricing/legal choices, outreach/backlinks, publish approval, and deploy approval. Do not imply it was performed.

## Scorecard

Write one typed record with schema version 1, period, registry version, status, coverage, both site measurements, portfolio ownership/shared findings, action IDs by lane plus deferred candidates, normalized errors, and workflow run ID. Then project it to a human page in this fixed order:

1. Executive summary
2. Coverage
3. Portfolio view
4. `usebrian.ai`
5. `studio.usebrian.ai`
6. Actions by lane
7. Errors
8. Methodology
9. Links to the workflow run and affected tasks

Read the record/page back before reporting success. A write or read-back failure makes the business run failed.

## Aggregate Slack text

Produce a compact delivery payload with status, period, coverage, one-line GSC/Google/AI movement per site, ownership/cannibalization findings, Brian/coding/human counts, errors/blockers, and links to the run, scorecard, and mutated tasks. Use only evidence recorded in this run. Do not turn delivery failure into measurement failure.
