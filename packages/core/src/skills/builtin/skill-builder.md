---
name: skill-builder
description: Draft a high-quality workspace skill from a user's description of what they want, grounded in what the brain already knows about the team. Used by the Brain's skill creator and available in chat when a user asks to create a skill.
license: MIT
compatibility: Designed for sidanclaw
metadata:
  author: sidanclaw
  category: productivity
  applies_to_app_type: any
  when_to_use: The user wants to create or draft a skill — "make me a skill that...", "turn this process into a skill", "teach the assistants how we do X". Gather what's genuinely missing (one round of questions at most), then draft the full skill for human review. Never save a skill without the user seeing the draft.
  tags: official
---

# Skill builder

A skill is the brain's procedural memory: a reusable, named procedure your
assistants follow. You are drafting one FOR HUMAN REVIEW — the human edits and
saves it; you never activate anything yourself. Quality bar: a teammate who has
never done this task should be able to follow the skill without asking anyone.

## 1. Decide: clarify or draft

Draft immediately when the intent names a concrete task with an implied shape
("weekly investor update the way I write them", plus brain context or a pasted
reference). Ask first when you cannot answer ALL of:

- **Trigger** — when should an assistant reach for this skill?
- **Output** — what does done look like (a message, a doc, a brain write)?
- **Constraints** — tone, format, cadence, audience, tools involved.

Ask at most ONE round, at most four questions, each answerable in a sentence.
Never ask for what the brain context or the pasted reference already answers.
If answers were already provided, you MUST draft — no second round.

## 2. Ground in what the brain knows

Use the workspace context you were given, in priority order:

1. **Pasted reference** — the strongest signal. Distill its structure, voice,
   and checklist into steps. Quote its phrasing for templates.
2. **Memories** — the team's stated preferences and patterns. If a memory
   contradicts a generic best practice, the memory wins.
3. **Entity vocabulary** — use the team's real names for people, companies,
   products, and projects in examples (not "Acme Corp").
4. **Existing skills** — match their tone and granularity; never duplicate
   one. If the intent overlaps an existing skill, say so instead of drafting
   a near-copy.

## 3. Draft shape

- **Name** — imperative and specific, 2-5 words ("Draft the weekly investor
  update", not "Investor helper").
- **Description** — one sentence: what it produces and for whom.
- **When to use** — the trigger phrases and situations, written so a model
  can match a real user request against it. This field does the routing;
  make it concrete.
- **Body** — markdown, numbered steps in execution order. Each step is an
  action with its acceptance check. Include: inputs to gather first, the
  steps, the output format (template if the reference provides one), and 1-2
  pitfalls if known. Under ~60 lines; a skill that needs more should be two
  skills.
- **Sensitivity** — suggest `confidential` if the procedure touches deals,
  finances, or personal data; `public` only for fully generic procedures;
  otherwise `internal`.

## 4. What never goes in a skill

- Secrets, API keys, or credentials (point to the connector instead).
- One-off facts that belong in memories or entities — reference them, don't
  freeze them ("check the current deal stage in the brain", not "the deal is
  at stage 3").
- Vague advice ("be helpful", "use good judgment") — every line must change
  what the assistant actually does.
