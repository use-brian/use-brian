---
name: import-voice-from-x
description: Import an X account's recent originals and propose voice rules for the brand assistant. Works on the connected account (default) or on any PUBLIC handle the operator names. Use when the operator says "learn my voice from X", "import voice", "import voice from @handle", "set up voice from my X account", or during onboarding of a new distribution app. Only valid for kind='app' distribution assistants.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: productivity
  applies_to_app_type: distribution
  when_to_use: When the operator wants to seed (or refresh) the brand voice from an X account's recent originals — their connected account, or any public handle they name. Skip when the assistant isn't a kind='app' distribution assistant, or when the source account has fewer than ~20 original posts.
  tags: official
---

# Import Voice From X

Pull recent originals from an X account — the connected handle by default, or any **public** handle the operator names — analyze the patterns that define the voice, and propose 5–10 voice rules for the operator to confirm. Persisted rules ride the team-memory tier under `category='voice'` and render in the L1 `## Voice Rules` block on every drafting turn.

## When to use

- The operator just connected X to a `kind='app'` distribution assistant and wants to seed the voice.
- The operator says "import voice", "learn my X voice", "set up brand voice from X", or similar.
- The operator names a handle: "import voice from @acme", "learn how @somebody writes". This works even with **no X connection** when the server has handle-import support configured.
- The brand voice has drifted (rebrand, new campaign) and the operator wants to refresh from current posts.

**Skip** when:
- The assistant is `kind='standard'` — voice rules are team-scoped only.
- The source account has fewer than ~20 original posts after filtering RTs/replies/media.

## Recipe

### 1. Verify the import tool is available

If `twitterImportVoiceSample` is not in the tool map, this workspace has neither an X connection nor server-side handle-import support. Do NOT hunt for it. Tell the operator their options: connect X (Feed → Platforms), or use the Voice page's "Import from pasted posts" — paste a dozen posts and you'll run the same analysis on them.

### 2. Fetch the sample

Connected-account import: `twitterImportVoiceSample({ limit: 200 })`.
Handle import: `twitterImportVoiceSample({ handle: '<the handle>', limit: 200 })` — pass the handle exactly as the operator gave it (a leading `@` is fine).

The adapter:

- Pulls the account's most recent ~200 posts via X API.
- Drops retweets, replies, quote-only, and pure-media posts.
- Returns `{ count, samples }` where `samples` is `VoiceSample[]`.

If `count < 20`, abort with a friendly message:

> "Only N original posts found in the recent timeline. Voice import needs about 20 to extract reliable patterns — please post more (or run this when there are more), then ask me to retry."

**Handle-import failure modes** — the tool returns `X error: <reason>`; narrate the reason, never a bare failure, and always land on a next step:

| Error contains | Say |
|---|---|
| `not found` / `suspended` | The handle doesn't exist (or is suspended) — ask for a corrected handle. |
| `protected account` | Only public accounts can be imported — offer the paste-in import instead. |
| `Daily handle-import cap` | The workspace hit today's handle-import limit — offer paste-in now or a retry tomorrow. |
| `No X account is connected` | Ask for the handle to import from (the no-connection path requires one). |

### 2b. Establish provenance — whose voice is this?

Before analyzing, decide which of two framings applies. **This decision changes the proposal wording and the saved rules** (feed-import-account.md D7):

- **The brand's own account** — the handle matches the connected profile, or the operator said it's theirs ("my handle", "our account"). Frame proposals as the **voice baseline**, exactly as before.
- **A third-party account** — anything else, including "an account we admire". Frame every proposal as a **style reference from @handle**: say so explicitly in the proposal ("Based on @handle's last N originals, here are style rules you could adopt"), name `@handle` in every rule's evidence line, and include the source in the saved `detail`. Never present someone else's patterns as the brand's established voice.

If ambiguous (a bare handle with no context), ask one short question: "Is @handle your account, or one you want to borrow style from?"

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
  - "Hashtags are reserved for `#Use Brian` only"
- A **detail** field with rationale + 2–3 short evidence excerpts (drawn verbatim from the sample so the operator can verify):
  - "Observed across 14 of 187 originals: 'no fluff, just the answer' (id ABC), 'spare me the preamble' (id DEF), 'short version' (id GHI)."
  - Third-party import: prefix the detail with the source — "Style reference from @handle. Observed across …" — so anyone reading the rule later knows where it came from.
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
- **Don't launder a third-party voice into the baseline.** A style reference imported from someone else's handle must say so in the proposal AND in every saved rule's detail. The operator approving it makes it theirs; hiding the source does not.
