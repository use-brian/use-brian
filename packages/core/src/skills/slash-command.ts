/**
 * Slash commands — `/name [args]` typed as the WHOLE chat message.
 *
 * A slash command is a deterministic entry point into the skill system: the
 * command name is a skill slug, and the entry seams (web chat route, channel
 * pipeline) thread it as an `enforceSlugs` entry into `injectSkills`, so the
 * named skill's full instructions land as a mandatory `# Required Skills`
 * block with every governance gate (enablement, clearance, app_type,
 * connectors) still applied. A name that resolves to no governance-passing
 * skill enforces nothing, and the caller lets the message fall through as
 * plain conversational text — a slash command can never escalate, only
 * select.
 *
 * Parsing is deliberately conservative: the ENTIRE message must be
 * `/name` or `/name <args>` (name = letter, then letters/digits/hyphens),
 * so paths (`/usr/bin`), fractions (`/2`), and prose containing a slash
 * never intercept. Names are matched case-insensitively and normalized to
 * lower case, because skill slugs are lower case.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Slash commands".
 */

export interface SlashCommandInvocation {
  /** Lower-cased command name; matched against skill slugs via enforceSlugs. */
  name: string
  /** Everything after the command word, trimmed. Empty for a bare `/name`. */
  args: string
}

const SLASH_COMMAND_RE = /^\/([A-Za-z][A-Za-z0-9-]{0,63})(?:\s+([\s\S]*))?$/

/**
 * Parse a chat message as a slash-command invocation. Returns null unless the
 * whole (trimmed) message is a single `/name [args]` form.
 */
export function parseSlashCommand(text: string): SlashCommandInvocation | null {
  const m = SLASH_COMMAND_RE.exec(text.trim())
  if (!m) return null
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() }
}

/**
 * The private-runtime-context block a resolved slash command rides in on.
 * Application-composed instruction, so it belongs in the trusted system
 * channel (formatPrivateRuntimeContext), never in a user-role message.
 * Callers push it ONLY when the enforced skill actually resolved
 * (enforcedPromptFragment non-empty) — an unknown command stays plain text.
 */
export function buildSlashCommandBlock(cmd: SlashCommandInvocation): string {
  return [
    `# Slash command: /${cmd.name}`,
    `The user's newest message is a slash-command invocation, not conversational text. It explicitly runs the "${cmd.name}" skill, whose full instructions are injected under "# Required Skills".`,
    `Arguments: ${cmd.args.length > 0 ? cmd.args : '(none)'}`,
    'Follow that skill now, treating the arguments as its input. Do not answer the message any other way, and do not describe the command instead of running it.',
  ].join('\n')
}
