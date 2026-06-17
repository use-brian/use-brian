---
name: import-voice-from-x
description: Import the connected X handle's recent originals and propose voice rules for the brand assistant. Use when the operator says "learn my voice from X", "import voice", "set up voice from my X account", or during onboarding of a new distribution app on X. Only valid for kind='app' assistants connected to X via OAuth.
license: MIT
compatibility: Designed for sidanclaw
metadata:
  author: sidanclaw
  category: productivity
  applies_to_app_type: distribution
  when_to_use: When the operator wants to seed (or refresh) the brand voice from the connected X account's recent originals. Skip when the assistant isn't a kind='app' distribution assistant on X, or when the operator has fewer than ~20 original posts.
  tags: official
---

# Import Voice From X

Pull recent originals from the connected X handle, analyze the patterns that define the brand voice, and propose 5–10 voice rules for the operator to confirm. Persisted rules ride the team-memory tier under `category='voice'` and render in the L1 `## Voice Rules` block on every drafting turn.

## When to use

- The operator just connected X to a `kind='app'` distribution assistant and wants to seed the voice.
- The operator says "import voice", "learn my X voice", "set up brand voice from X", or similar.
- The brand voice has drifted (rebrand, new campaign) and the operator wants to refresh from current posts.

**Skip** when:
- The assistant is `kind='standard'` — voice rules are team-scoped only.
- The connected X account has fewer than ~20 original posts after filtering RTs/replies/media.
- The operator wants per-platform voice rules (current shape is one rule set per assistant; multi-platform support is future work).

## Recipe

### 1. Verify the assistant has X connected

If `twitterImportVoiceSample` is not in the tool map, the assistant is not connected to X. Stop and tell the operator to connect X via the workspace Distribution tab before re-running the skill.

### 2. Fetch the sample

Call `twitterImportVoiceSample({ limit: 200 })`. The adapter:

- Pulls the handle's most recent ~200 posts via X API.
- Drops retweets, replies, quote-only, and pure-media posts.
- Returns `{ count, samples }` where `samples` is `VoiceSample[]`.

If `count < 20`, abort with a friendly message:

> "Only N original posts found in the recent timeline. Voice import needs about 20 to extract reliable patterns — please post more (or run this when there are more), then ask me to retry."

### 3. Analyze the sample

Read every sample. Look for repeated patterns across these dimensions:

| Dimension | What to look for |
|---|---|
| **Tone register** | warm-direct / formal / playful / authoritative / contrarian |
| **Sentence length** | typical word count, range, exceptions (e.g. one-word punchlines) |
| **Opening hooks** | questions / declarative statements / quotes / numbers / "Hot take:" / threads |
| **Closing patterns** | sign-offs, calls to action, none |
| **Emoji rules** | never / sparingly (\<5%) / characteristic / heavy |
| **Hashtag rules** | never / 1–2 / multiple / branded only |
| **Recurring phrases** | 2–4-word phrases that recur 3+ times in the sample |
| **Topic taxonomy** | what topics this handle posts about |
| **Language** | observe but don't tag — Gemini handles language register at draft time |

**Bias toward fewer, higher-confidence rules.** Five sharp rules beat ten fuzzy ones. Skip dimensions where the sample doesn't show a clear pattern.

### 4. Draft the proposal

For each rule you'll propose, prepare:

- A one-line **summary** (memory `summary` field). Lead with the rule, not the explanation. Examples:
  - "Tone: warm-direct, never sycophantic"
  - "Sentences average 12–18 words; one-word punchlines are characteristic"
  - "Open with a number or a question; almost never declarative"
  - "Emoji are forbidden except 👋 in greetings"
  - "Hashtags are reserved for `#sidanclaw` only"
- A **detail** field with rationale + 2–3 short evidence excerpts (drawn verbatim from the sample so the operator can verify):
  - "Observed across 14 of 187 originals: 'no fluff, just the answer' (id ABC), 'spare me the preamble' (id DEF), 'short version' (id GHI)."
- A **confidence** value (0.0–1.0). Calibrate honestly — 0.9 means you'd bet the next 50 posts on it; 0.6 means it's a tendency, not a rule.

### 5. Render the proposal

Show the operator a numbered list. For each proposed rule include the summary, evidence, and confidence. Ask explicitly: **"Approve all, or pick the ones to keep?"**

If the operator already has voice rules saved (call `getMemory` with `query` set to nothing useful — instead inspect the L1 `## Voice Rules` section that's already in your context), highlight any proposed rule that **conflicts** with an existing one. Ask: keep the existing, replace it, merge them, or drop the new proposal?

### 6. Persist approved rules

For each approved rule, call:

```
saveMemory({
  type: 'preference',
  scope: 'team',
  category: 'voice',
  summary: <rule summary>,
  detail: <rationale + evidence>,
})
```

`category='voice'` is the only category value the saveMemory tool currently accepts. Set it explicitly on every voice rule write — without it the memory will not appear in the `## Voice Rules` L1 block.

After saving, summarise in chat: "Saved N voice rules. They will shape every draft from this point on. Re-import any time to refresh."

## Anti-patterns

- **Don't save voice rules silently.** Always propose-confirm. Voice changes affect every team member's drafting; the operator must see and approve.
- **Don't generate rules from a thin sample.** Below 20 originals, signal-to-noise is too low. Tell the operator to come back later.
- **Don't tag rules by language.** Gemini handles language register natively at draft time. A `voice:zh:tone` style rule is more maintenance than it's worth.
- **Don't echo every dimension as a rule.** If emoji usage is unclear in the sample, skip the emoji rule entirely. Empty/uncertain rules are worse than no rule.
- **Don't write rules that aren't actionable.** "Posts about technology and life" is descriptive but useless for drafting. "Lead with concrete examples; abstract claims need a 'for example' before the next sentence" is actionable.
