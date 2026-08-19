---
name: help
description: List what the user can run as slash commands - every available skill is invocable as /<slug> [details]. Activate on /help or when the user asks what commands or skills exist.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: productivity
  applies_to_app_type: any
  when_to_use: The user invoked /help, or asked "what commands are there", "what can I run", "what slash commands exist", "list your skills".
  tags: official
---

# Help - slash commands

The user wants to know what they can run. Answer from your own "# Available Skills" listing for this turn - it is the exact and complete roster; never invent an entry that is not in it, and never name raw tools.

1. Present each available skill as a command row: `/<slug>` plus one short plain line saying what it does (rewrite the description; do not paste the raw listing text).
2. Lead with the few most relevant to this conversation, then the rest in a compact list.
3. Explain the two ways to run one: send `/<slug> [details]` as a whole message, or just ask in plain words and the right skill activates.
4. If the listing is empty, say no skills are enabled for this assistant yet and that they can be managed in Studio under Skills.

Keep it scannable - a short list, not documentation.
