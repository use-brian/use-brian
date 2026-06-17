---
name: onboarding-profile
description: Cold-start interview that builds the user's own profile in the brain from a couple of quick questions, then reflects the saved profile back.
license: MIT
compatibility: Designed for sidanclaw
metadata:
  author: sidanclaw
  category: productivity
  applies_to_app_type: any
  when_to_use: The user wants the brain to know them — "help me build a profile of myself", "tell the brain about me", "set up my profile", or the cold-start "Tell me about you" card. Run the short interview, write the self profile, reflect it back. If a profile already exists, offer to update it instead of starting over.
  tags: official
---

# Onboarding — your profile

The brain is empty and the user wants it to know *them*. Run a short, friendly interview, then write their profile so the next assistant answer already speaks their context. This is often the user's first real interaction — be brief, write the real primitive, and let them *see* the brain get smarter in a single message.

There is no web research here. Everything is user-stated, so this flow is instant and costs no research turn. Don't switch to research mode.

## 1. Orient and dedup

First check whether the brain already knows the user — their self profile is usually in your context, or use `getEntity` / `search`. If a profile already exists, **don't re-onboard**: say what you already have on file and offer to update it. Otherwise open by naming the shape and length, e.g. "I'll set you up in a couple of quick questions, then show you what I saved."

## 2. Ask once, batched

In a single normal turn, ask conversationally for:

- **Name and role / title** — the two that matter most.
- **What they're working on right now** — one line.
- **Who they work with most** — cofounders, teammates, by name. For anyone they want the brain to really know, suggest what helps it identify (and later research) that person: a **full name + where they work**, and a **LinkedIn or X handle** if handy.

Ask like a person, not a form. Don't interrogate field-by-field across many turns — one friendly message covers it, and you synthesize the rest from their answer.

## 3. Write the right primitives

When they answer, write immediately — brain writes are reversible, so don't ask "should I save this?" first:

- `updateSelfProfile` once with `name`, `role`, and `company` (their employer, captured as a profile attribute — do **not** create a company entity here; the company-research flow owns that). Put anything off-slot (focus, location, what they care about) in `extra`. No `sources` — this is user-stated.
- `saveContact` for each named coworker, linking them to the user (cofounder, teammate).
- `saveMemory` (`scope: 'user'`) for "what I'm working on" so it's retrievable as a standalone fact.

## 4. Reflect and hand off

Echo the one-line profile you saved so the user sees the brain learn: "Your brain now knows: **{name}, {role} at {company}**, working on {focus} with {people}." Then point at the natural next step: "Want me to research your company next so the brain has the full picture?"

Writing the self profile is what makes the "Tell me about you" card disappear — there is no separate "mark complete" step.
