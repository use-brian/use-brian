---
name: onboarding-company
description: Cold-start flow that adds the user's company to the brain from the web — confirm the company first (a cheap standard turn), research it, show the findings with sources, then write a company entity, key people, and sourced facts on the user's OK.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: research
  applies_to_app_type: any
  when_to_use: The user wants the brain to know their company, seeded from the web — "research my company", "add my company to the brain", or the cold-start "Research your company" card. Confirm which company first in a standard turn, then research it, show the findings, and write a company entity + key people + sourced facts on assent.
  tags: official
---

# Onboarding — research your company

The user wants the brain to know their company, seeded from the web. Two things make this flow good: spend the research turn on the *actual* research (not the "which company?" round-trip), and let the user prune a wrong fact *before* it lands in the brain.

## The two-turn cadence — do not break it

This flow is launched with research deferred to the *answer* turn. So:

- **Turn 1 (standard, no web search):** confirm which company. Do not run any web search or research tool yet.
- **Turn 2 (research armed):** once you have the company name, research it.

**Never search the web before you know the company name.** The user's research turn is reserved for the real research — searching on turn 1 wastes it.

## 1. Orient and state the cost

Open by naming the plan and the cost honestly, e.g. "I'll confirm which company, then research it on the web (this uses one of your research turns), then show you what I found before saving anything."

## 2. Confirm which company, and suggest what helps

Ask conversationally which company they work at, and in the same breath suggest the details that make the research land — so they know what's worth sharing instead of guessing. Keep it a friendly sentence, not a form; the name alone is enough to start, the rest just disambiguates and sharpens:

- **Name** (the only must-have) and **website or domain** — the domain alone resolves most ambiguity.
- A **LinkedIn or Crunchbase** link if one's handy.
- A **product or two**, the **market**, or rough **location / size** — most useful when the name is common.

Reassure them that just the name is fine. This is turn 1; do not research yet — only gather what they offer.

## 3. Brain first

Before any web search, check the brain for the company (`getCompany` / `listCompanies` / `search`). If it's already there, offer to update it rather than recreate it.

## 4. Research

Now research the company (research mode is armed). Stay brain-first, work multiple angles, and triangulate across at least two sources — never fabricate. Cover:

- **What it does** and its market.
- **Key people** — founders and leadership, by name and role.
- **Notable facts** worth keeping, each tied to the source it came from.
- **Links** worth keeping — site, key profiles.

If the name is ambiguous or you can't confidently identify the company, ask for one disambiguating signal (the domain or the location) rather than researching the wrong one. To research a specific **person** well — a founder or a key teammate the user names — the signals that pin a person down are their **full name, their company, their role, and a LinkedIn or X handle**; if a person matters and the web is thin, say which of these would help and ask for it.

## 5. Show the findings, then write

Present a short, structured findings block *before* writing anything:

- **Company** — name, domain, industry.
- **Key people** — name + role.
- **Notable facts** — each with its source URL; flag any single-source claim.

Then ask: "Want all of this in the brain, or should I drop anything?" On the user's OK (honoring anything they pruned), write the real primitives:

- `saveCompany` for the company, keeping its `entityId`.
- `saveContact` for each key person, linked to the company (works_at).
- `saveMemory` anchored to the company `entityId` for each notable fact, with its source URL.
- `updateSelfProfile` only if the research clarified the user's *own* role or company.

Keep anything the user volunteered in confidence off the web-sourced path.

## 6. Reflect and hand off

Echo what landed: "Added **{company}** + {N} people + {N} sourced facts to the brain." Then suggest the next step — connect a channel, or turn a topic into a page.

Saving the company is what makes the "Research your company" card disappear — there is no separate "mark complete" step.
