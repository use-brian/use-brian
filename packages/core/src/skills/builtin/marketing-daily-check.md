---
name: marketing-daily-check
description: Daily marketing close-loop — read this period's `platform_engagement_digest`, compare to the workspace's `commitment:goal_marketing_*` goals, diagnose what worked / what didn't, and propose adjustments for the next period as a new plan memory. Use via a daily scheduled workflow, or when the operator asks "how did this week's posts do?", "what should we change?", "are we on track?".
license: MIT
compatibility: Designed for sidanclaw
metadata:
  author: sidanclaw
  category: marketing
  applies_to_app_type: distribution
  when_to_use: A daily (or weekly) scheduled turn for any workspace publishing through the feed app (Threads / X). Also valid as an ad-hoc operator query. Skip when no `platform_engagement_digest` Episodes have landed yet (the producer hasn't run, or there are no published posts to digest).
  tags: official
---

# Marketing daily check

Close the marketing self-improvement loop: read the latest `platform_engagement_digest` Episode, compare to the workspace's marketing goals (memories tagged `commitment:goal_marketing_*` per `decisions-log.md` 2026-05-14 entry 23), diagnose what's working and what isn't, and save an adjusted plan for the next period. The next period's posts then carry forward what's working; future iterations build on this plan via the same loop.

The producer half — `packages/api/src/feed/engagement-digest-worker.ts` — runs daily and emits one `platform_engagement_digest` Episode per active distribution profile (Threads + X). Pipeline B's digest branch turns each Episode into per-post engagement memories tagged `engagement` + `platform-digest`, linked to their post Episodes via `platform_engagement_for` edges. This skill is the model-side consumer.

Per `docs/historical/decisions-log.md` 2026-05-14:

- **Goals** = memories tagged `commitment:open` + `commitment:goal_marketing_<kind>` scoped `(NULL, assistant_id)` (workspace-shared). Workflow-owned — the lifecycle worker never auto-resolves them.
- **Engagement signal** = `platform_engagement_digest` Episodes + the engagement memories Pipeline B materialised from them.
- **Plan** = a memory tagged `marketing:plan_for:<iso-period>` with the period's posting strategy.
- **Self-improvement loop** = each daily turn reads (goals + observed engagement + last plan) and writes (new plan), via the existing event-triggered cron-turn pattern (entry 19).

## When to use

- A daily / weekly scheduled workflow invokes this skill (cron-session turn).
- The operator asks "how did this period do?", "are we on track?", "what should we change?".

**Skip** when:

- No `platform_engagement_digest` Episodes have landed for the workspace yet (the producer hasn't run, or there are no published posts to digest).
- The assistant has no `commitment:goal_marketing_*` memories — propose creating one first ("what are we trying to grow this quarter — followers / engagement / a specific theme?"). Don't fabricate a goal.

## Recipe

### 1. Read marketing goals

```
searchMemory({
  tags: ['commitment:open', 'commitment:goal_marketing'],
  limit: 10,
})
```

Or query each kind individually if the workspace uses specific suffixes:

```
searchMemory({ tags: ['commitment:open', 'commitment:goal_marketing_engagement'] })
searchMemory({ tags: ['commitment:open', 'commitment:goal_marketing_followers'] })
searchMemory({ tags: ['commitment:open', 'commitment:goal_marketing_theme'] })
```

Each goal memory's `summary` + `detail` carries the target (e.g. "Reach 500 weekly engagements", "Add 200 followers by quarter-end").

### 2. Read the latest engagement digest

```
recentEpisodes({
  sourceKind: 'platform_engagement_digest',
  since: '<period-start-iso>',
  limit: 5,
})
```

The Episode's `contentRef.metrics` carries the structured payload: `per_post[]` (each with `post_episode_id`, `views`, `likes`, `replies`, `reposts`) + `aggregate` (`total_engagement`, `follower_delta` on Threads, `top_post_episode_id`).

If multiple platforms posted in the period (Threads + X), there's one digest Episode per platform — read both.

### 3. Read the prior plan

```
searchMemory({
  tags: ['marketing:plan_for'],
  limit: 1,
})
```

The most recent plan memory grounds the comparison: "Last period we tried weekend posts and short-form. What happened?"

### 4. Diagnose

Compare observed vs target:

- **Gap to goal** — `aggregate.total_engagement` (or `follower_delta`) vs the goal's target value.
- **Top vs flop** — which posts had highest / lowest engagement. The `top_post_episode_id` in `aggregate` points at the period's best performer. Use `getEntity` / `recentEpisodes(parentEpisodeId)` to inspect the post.
- **Theme correlation** — if posts carry topic tags (saved by ingestion or set by the prior plan), check whether some themes consistently out-perform.
- **Platform comparison** — if both Threads and X are active, compare which platform drove what share of total engagement and follower change.

Be honest. "We hit 60% of the engagement goal; reposts dropped after we stopped reply-banter" is more useful than "engagement was healthy".

### 5. Propose adjustments + save the new plan

Draft the adjustments tightly (the operator reads these). Then persist as a memory:

```
saveMemory({
  type: 'context',
  scope: 'team',
  summary: 'Marketing plan for week of <iso-period-start>: <2-3 line plan summary>',
  detail: '<diagnosis + adjustments + concrete post types/times/themes to try>',
  tags: [
    'marketing:plan_for:<iso-period-start>',
    'marketing:plan',                            // umbrella tag for `searchMemory({tags:[...]})` later
  ],
})
```

Conventions:

- `marketing:plan_for:<iso>` — period-specific (e.g. `marketing:plan_for:2026-W22`). Lets future turns retrieve the plan for a specific period.
- `marketing:plan` — umbrella. Lets the next turn pick up "the most recent plan" without knowing the period.
- Plans are `type: 'context'` (informs future reasoning) with `scope: 'team'` (workspace-shared).

### 6. Optionally flag big gaps

If the gap to goal is large and persistent (e.g. < 50% of target for two consecutive periods), surface it as a memory the operator should see — but **don't fabricate a goal** and don't escalate trivially. The retrieval-layer will surface the memory in the operator's next chat turn.

```
saveMemory({
  type: 'context',
  scope: 'team',
  summary: 'Marketing engagement off target: <N>/<target> for the <period>; second period below threshold.',
  detail: '<root cause if known + recommended next step>',
  tags: ['marketing:off_target', 'goal:<kind>'],
})
```

(No `commitment:*` tag — there's no sprint-variance-style resolver for marketing off-target yet; keeping it a plain memory avoids the lifecycle worker treating it as something to auto-close.)

### 7. Return a brief status

A short turn output (or chat reply when the operator queried) covering:

- N% of the engagement goal hit this period.
- Top performer + one-line "why it worked" guess.
- 1-3 concrete adjustments saved as the next plan.

When invoked silently on the cron path, the saved plan memory **is** the output — don't write a chat message no one will read.

## What NOT to do

- **Do not** save a `commitment:*` memory for marketing goals from this skill — goal commitments are *configured*, not auto-generated. If a goal is missing, ask the operator (in the chat turn), don't fabricate one.
- **Do not** include the L2 persona (voice / regional flavour / hardsell rules) in this skill — that lives in the assistant's L2 prompt (`docs/crews/marketing-assistant-prompt.md`). This skill is just the close-loop runbook.
- **Do not** rewrite past plans. Each period's plan is its own memory; supersession happens through `saveMemory` writing the new period — old plans stay as history for the loop's "what did we try" lookback.
- **Do not** post content from this skill — content drafting and posting are separate tools (`threadsCreatePost` etc., with their confirmation gates). This skill *plans*; the operator (or a separate posting workflow) *posts*.
- **Do not** treat per-post `views` as engagement — `totalEngagement` in the digest is `likes + replies + reposts` only (views are a separate quality signal, not engagement).

## How the loop closes

```
   Daily scheduled turn invokes this skill
                     │
                     ▼
   Step 1: read goals (commitment:goal_marketing_*)
   Step 2: read digest Episode + engagement memories
   Step 3: read last plan (marketing:plan)
                     │
                     ▼
   Step 4: diagnose
                     │
                     ▼
   Step 5: save new plan (marketing:plan_for:<period> + marketing:plan)
                     │
                     ▼
   Next period's posting workflow reads marketing:plan → executes
                     │
                     ▼
   Next period's engagement-digest-worker tick → new digest Episode
                     │
                     ▼
   Loop closes.
```

Each turn reads its own past output — that's the moat working as designed (per `docs/plans/company-brain/README.md` → "the longer it's used, the smarter it gets").
