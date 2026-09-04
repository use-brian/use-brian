# Slash commands

Slash commands are deterministic entry points into skills and workflows. The
same text form is accepted by web chat and every messaging adapter.

- `/skill-slug [arguments]` invokes a governed skill by slug.
- `/skill <skill-slug> [arguments]` is the platform-neutral explicit skill form.
- `/workflow <workflow-id-or-name> [arguments]` invokes one enabled workflow.
- `/ask <prompt>` remains a channel convenience for ordinary conversation.

Native channel menus register `ask`, `skill`, and `workflow` fallbacks plus one
provider-safe command for each active workspace skill and enabled workflow.
Skills keep a readable normalized slug where possible; workflow commands use a
`workflow_` prefix. Deterministic suffixes disambiguate collisions and names
over the providers' 32-character limit. Telegram and Discord each allow 100
commands, so targets beyond the dynamic capacity remain available through the
fallback commands. Runtime skill governance and workflow access remain
authoritative after a command is selected.

Telegram treats any bot command addressed to the current bot as an explicit
group invocation and rejects commands addressed to another bot. Discord
registers global application commands when a BYO bot is connected; Gateway
application-command interactions are acknowledged promptly and normalized into
the same text forms before entering the channel pipeline.

The generated catalog is also rebuilt by shared chat and channel processing.
An incoming native command therefore resolves to the exact skill slug or
workflow UUID before the model runs; adapters only preserve command text and do
not make authorization decisions.

Connecting a Telegram or Discord bot publishes the current catalog immediately.
Skill and workflow store write hooks schedule the same reconciliation after
creates, edits, renames, workflow enablement changes, and deletions, including
mutations originating from assistant tools rather than only REST routes.
