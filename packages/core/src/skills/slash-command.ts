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

export type PreparedSlashCommandInvocation =
  | { kind: 'skill'; name: string; args: string; command: SlashCommandInvocation }
  | { kind: 'workflow'; target: string; workflowId?: string; args: string; command: SlashCommandInvocation }
  | { kind: 'ask'; prompt: string; command: SlashCommandInvocation }

export type NativeSlashCommandTarget =
  | { kind: 'skill'; slug: string; name: string; description?: string | null }
  | { kind: 'workflow'; workflowId: string; name: string; description?: string | null }

export type NativeSlashCommand = {
  name: string
  description: string
  target: NativeSlashCommandTarget
}

export type NativeSlashCommandCatalog = {
  commands: NativeSlashCommand[]
  omitted: NativeSlashCommandTarget[]
}

const SLASH_COMMAND_RE = /^\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\s+([\s\S]*))?$/

const NATIVE_COMMAND_LIMIT = 100
const NATIVE_COMMAND_NAME_LIMIT = 32
const RESERVED_NATIVE_COMMANDS = new Set(['ask', 'skill', 'workflow'])

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
 * Resolve the shared command namespaces used by native channel menus. A direct
 * `/slug` remains the compact skill form; `/skill slug` is its explicit form.
 */
export function prepareSlashCommand(text: string): PreparedSlashCommandInvocation | null {
  const command = parseSlashCommand(text)
  if (!command) return null

  if (command.name === 'ask') {
    return command.args ? { kind: 'ask', prompt: command.args, command } : null
  }

  if (command.name === 'skill') {
    const target = splitTarget(command.args)
    if (!target || !/^[a-z][a-z0-9-]{0,63}$/i.test(target.value)) return null
    return {
      kind: 'skill',
      name: target.value.toLowerCase(),
      args: target.rest,
      command,
    }
  }

  if (command.name === 'workflow') {
    const target = splitTarget(command.args)
    return target
      ? { kind: 'workflow', target: target.value, args: target.rest, command }
      : null
  }

  return { kind: 'skill', name: command.name, args: command.args, command }
}

function splitTarget(value: string): { value: string; rest: string } | null {
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+([\s\S]*))?$/.exec(value.trim())
  if (!match) return null
  return { value: match[1] ?? match[2] ?? match[3], rest: (match[4] ?? '').trim() }
}

/** Build the deterministic roster published to Telegram and Discord. */
export function prepareNativeSlashCommands(
  targets: NativeSlashCommandTarget[],
  limit = NATIVE_COMMAND_LIMIT - RESERVED_NATIVE_COMMANDS.size,
): NativeSlashCommandCatalog {
  const sorted = [...targets].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    const aId = a.kind === 'skill' ? a.slug : a.workflowId
    const bId = b.kind === 'skill' ? b.slug : b.workflowId
    return aId.localeCompare(bId)
  })
  const skills = sorted.filter((target) => target.kind === 'skill')
  const workflows = sorted.filter((target) => target.kind === 'workflow')
  const ordered: NativeSlashCommandTarget[] = []
  for (let i = 0; i < Math.max(skills.length, workflows.length); i++) {
    if (skills[i]) ordered.push(skills[i])
    if (workflows[i]) ordered.push(workflows[i])
  }
  const used = new Set(RESERVED_NATIVE_COMMANDS)
  const commands: NativeSlashCommand[] = []
  const omitted: NativeSlashCommandTarget[] = []

  for (const target of ordered) {
    if (commands.length >= Math.max(0, limit)) {
      omitted.push(target)
      continue
    }
    const identity = target.kind === 'skill' ? `skill:${target.slug}` : `workflow:${target.workflowId}`
    const base = target.kind === 'skill'
      ? nativeCommandStem(target.slug)
      : `workflow_${nativeCommandStem(target.name)}`
    let name = base.slice(0, NATIVE_COMMAND_NAME_LIMIT)
    if (!name || used.has(name) || base.length > NATIVE_COMMAND_NAME_LIMIT) {
      const suffix = stableCommandHash(identity)
      const stemLength = NATIVE_COMMAND_NAME_LIMIT - suffix.length - 1
      name = `${base.slice(0, stemLength).replace(/_+$/g, '')}_${suffix}`
    }
    if (!name || used.has(name)) {
      omitted.push(target)
      continue
    }
    used.add(name)
    const prefix = target.kind === 'skill' ? 'Skill' : 'Workflow'
    const detail = target.description?.trim()
    commands.push({
      name,
      description: `${prefix}: ${target.name}${detail ? ` - ${detail}` : ''}`.slice(0, 100),
      target,
    })
  }
  return { commands, omitted }
}

/** Resolve a provider-registered command to its exact governed target. */
export function resolveNativeSlashCommand(
  text: string,
  catalog: NativeSlashCommandCatalog,
): PreparedSlashCommandInvocation | null {
  const command = parseSlashCommand(text)
  if (!command) return null
  const entry = catalog.commands.find((candidate) => candidate.name === command.name)
  if (!entry) return null
  return entry.target.kind === 'skill'
    ? { kind: 'skill', name: entry.target.slug, args: command.args, command }
    : {
        kind: 'workflow',
        target: entry.target.name,
        workflowId: entry.target.workflowId,
        args: command.args,
        command,
      }
}

function nativeCommandStem(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

function stableCommandHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(-7)
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

/** Trusted runtime instruction for the `/workflow` namespace. */
export function buildWorkflowSlashCommandBlock(
  command: Extract<PreparedSlashCommandInvocation, { kind: 'workflow' }>,
): string {
  return [
    `# Slash command: /workflow`,
    command.workflowId
      ? `The user's newest message explicitly invokes workflow ${JSON.stringify(command.target)} with exact id ${command.workflowId}.`
      : `The user's newest message explicitly invokes the workflow identified by ${JSON.stringify(command.target)}.`,
    command.workflowId
      ? 'Run exactly that workflow id. Do not list or choose another workflow.'
      : 'Resolve an exact workflow id first; otherwise list workflows and require one exact case-insensitive name match. Never guess among multiple matches.',
    `Run it now with runWorkflow. Pass the arguments as the input field "arguments": ${command.args.length > 0 ? command.args : '(none)'}.`,
    'Do not create, edit, enable, or substitute another workflow. Report the run outcome honestly.',
  ].join('\n')
}
