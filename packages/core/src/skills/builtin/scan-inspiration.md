---
name: scan-inspiration
description: Scan the connected X handle's surroundings (home timeline, an X List, recent search) for posts worth replying to. Returns 5–10 ranked candidates with a one-line "why this one" per candidate. Use when the operator asks "what should I reply to?", "find me inspiration", "scan timeline", or schedules recurring scans via cron.
license: MIT
compatibility: Designed for sidanclaw
metadata:
  author: sidanclaw
  category: communication
  applies_to_app_type: distribution
  when_to_use: When the operator wants to surface replyable posts from the connected handle's network. Skip when no inspiration sources are configured (no list, no search query, timeline disabled) — direct the operator to set them up first.
  tags: official
---

# Scan Inspiration

Surface 5–10 ranked candidate posts the brand assistant could productively reply to. Pulls from up to three sources (home timeline, an operator-curated X List, recent-search), dedups, filters, and scores against the team voice. The operator picks one; the existing approval-gated reply flow takes it from there.

## When to use

- The operator says "what's worth replying to?", "scan inspiration", "find me something to reply to", or similar.
- A scheduled-job invocation set up via the cron tools fires at the operator's chosen cadence.

**Skip** when:
- The assistant is `kind='standard'` — inspiration scanning is a distribution feature.
- None of the three inspiration tools are in the tool map (X is not connected, or the integration is in a degraded state).
- All three inspiration sources are disabled / unset.

## Configuration — `inspiration:*` memory keys

Operators tune the scan via reserved team-memory keys. Read these by inspecting the team-memory index and `getMemory` lookups; if absent, fall back to defaults.

| Memory key | Default | Purpose |
|---|---|---|
| `inspiration:include_timeline` | `true` | Whether to pull the home timeline as a source |
| `inspiration:list_id` | unset | X List ID to pull (operator-curated, highest-signal source) |
| `inspiration:search_query` | unset | Recent-search query string (X search syntax) |
| `inspiration:result_count` | `5` | How many ranked candidates to return |

If none of timeline / list / search resolves to a usable source, abort with a configuration-help message:

> "I have no inspiration sources configured. Add at least one: enable the home timeline, set `inspiration:list_id` to one of your X Lists, or set `inspiration:search_query` to a topic you care about. Then ask me to scan again."

## Recipe

### 1. Read the configuration

Read the four `inspiration:*` memory keys (and any existing `category='voice'` memories which are already in the L1 `## Voice Rules` block).

### 2. Fetch in parallel

For each enabled source, fire the corresponding tool (parallel, not sequential):

- `inspiration:include_timeline = true` → `twitterListHomeTimeline({ limit: 50 })`
- `inspiration:list_id` set → `twitterListFromList({ listId, limit: 50 })`
- `inspiration:search_query` set → `twitterSearchTopic({ query, limit: 50 })`

If a tool returns an error (rate limit, expired token, etc.), continue with the rest — partial results are better than none.

### 3. Dedup

Concatenate the candidate arrays. Drop duplicates by `(platform, externalId)`.

### 4. Filter

Drop candidates that:

- Were authored by the connected handle itself (own tweets — skill is for finding *external* posts to reply to).
- Have already been replied to by this assistant (no current built-in check; if reply history matters strongly, the operator should add a `inspiration:exclude_recent_replies` extension later).
- Are pure self-promotion / off-brand topics that obviously won't earn a thoughtful reply.

### 5. Score

For each surviving candidate, assign a `score` (0.0–1.0) and write a one-line `whyMatch`. Score on:

| Signal | Weight |
|---|---|
| **Topic match** vs the team's voice/topic taxonomy | high |
| **Replyable hook** — questions, hot takes, asks, "what do you think?" | high |
| **Voice fit** — would this match what we plausibly engage with? | high |
| **Engagement** — replies > likes (active conversation), recency | medium |
| **Author reputation** — verified, followed by us, in our List | medium |

The `whyMatch` line should be **specific**, not generic. Bad: "On-topic and active." Good: "Asks how teams handle voice tuning at scale — directly in your wheelhouse, only 2 replies so far so you can land an early one."

### 6. Rank and trim

Sort by `score` descending. Trim to `inspiration:result_count` (default 5).

### 7. Render the result

Show the operator a numbered list. For each candidate include:

- Author handle
- Short text excerpt (truncate at ~140 chars with ellipsis)
- Engagement summary (likes, replies)
- `whyMatch` line

End with: **"Pick a number to draft a reply, or ask me to scan again with different sources."**

**Do NOT auto-draft replies.** The operator picks a candidate and the existing `twitterReplyToPost` flow (Phase 2, approval-token-gated) handles drafting and publication.

## Anti-patterns

- **Don't auto-draft.** Inspiration is discovery; the existing approval-gated reply flow owns drafting and publication. Bypassing that gate skips the safety judge and the audit log.
- **Don't surface own-tweets.** "Reply to your own post" suggestions waste the operator's attention.
- **Don't generate fake `whyMatch` lines.** If a candidate barely fits, drop it. Five strong candidates beat ten padded ones.
- **Don't ignore voice fit.** A high-engagement post that's tonally off-brand is a bad inspiration. The team voice memories (in your context) are the filter.
- **Don't burst the rate limit.** One scan = up to 3 reads. If the operator schedules this every 5 min via cron, that's fine; if every minute, the X read pool exhausts.
