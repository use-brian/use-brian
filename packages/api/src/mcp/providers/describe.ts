/**
 * Static descriptor builders for provider `describe()`.
 *
 * Descriptors are computed without credentials, network, child processes or
 * policy reads. Official families build their tools once per process from the
 * real core factories over inert ports (every port method throws if called),
 * so `describe()` reports exactly the tools the family's activation wires, with
 * their model-facing description and JSON Schema; `OFFICIAL_CONNECTOR_TOOLS`
 * (the registry the web UI and policy toggles read) supplies the governance
 * metadata (classification, default policy, group) for every registered name. A built
 * tool missing from the registry is still described (from the tool itself), so
 * the hosted drift sweep can report it as silent-invisible; a registry row no
 * factory builds is not described (it is an orphan, and advertising it would
 * promise a capability activation cannot provide).
 *
 * See docs/architecture/integrations/mcp.md → "Provider activation" and
 * "Drift sweep".
 */
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { jsonSchemaFromZod } from '@use-brian/agent-runtime/engine/query-loop.js'
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import type { ProviderFamily, ToolDescriptor } from './types.js'

/**
 * A port whose every property is itself and whose every call throws. Core
 * factories only close over their ports, so a factory built over this
 * returns real tool metadata and can never perform an effect.
 */
export function inertPort<T>(label: string): T {
  const fail = () => { throw new Error(`${label}: descriptor ports are inert; activate the provider to call a tool.`) }
  const port: unknown = new Proxy(fail, {
    get: (_target, property) => (property === 'then' ? undefined : port),
    apply: fail,
  })
  return port as T
}

/** JSON Schema of a built tool's input, or undefined when it has no zod schema. */
function toolInputJsonSchema(tool: Pick<Tool, 'inputSchema'>): Record<string, unknown> | undefined {
  const schema = tool.inputSchema as unknown as { _def?: unknown } | undefined
  return schema?._def ? jsonSchemaFromZod(schema as { _def: unknown }) as unknown as Record<string, unknown> : undefined
}

/** Memoize a `describe()` body: factories are built over inert ports once per process. */
export function memoDescribe(build: () => ToolDescriptor[]): () => ToolDescriptor[] {
  let cached: ToolDescriptor[] | undefined
  return () => (cached ??= build())
}

/**
 * Describe a family from its core factories. `builders` maps each registry
 * connector id the family serves to the factory call that builds its tools
 * over inert ports. A builder that throws contributes nothing (and is logged),
 * which the descriptor tests and the drift sweep both surface.
 */
export function describeFactoryTools(
  family: ProviderFamily,
  builders: Readonly<Record<string, () => readonly Tool[]>>,
): ToolDescriptor[] {
  const out: ToolDescriptor[] = []
  for (const [connectorId, build] of Object.entries(builders)) {
    let built: readonly Tool[]
    try {
      built = build()
    } catch (error) {
      console.error(`[mcp-describe] ${family}/${connectorId} factory could not be described:`, error)
      continue
    }
    const byName = new Map(built.map((tool) => [tool.name, tool]))
    const rows = OFFICIAL_CONNECTOR_TOOLS[connectorId] ?? []
    for (const row of rows) {
      const tool = byName.get(row.name)
      if (!tool) continue
      const schema = toolInputJsonSchema(tool)
      out.push({
        name: row.name,
        // The model sees the tool's own description once activated; search must show the same text.
        description: tool.description,
        family,
        connectorId,
        classification: row.classification,
        defaultPolicy: row.defaultPolicy,
        ...(row.group ? { group: row.group } : {}),
        // Policy fallback is `requiresConfirmation ? 'ask' : 'allow'`, so the
        // registry's default policy is the static confirmation flag.
        requiresConfirmation: row.defaultPolicy === 'ask',
        inputSchema: { kind: 'static', family, toolName: row.name, ...(schema ? { schema } : {}) },
        origin: 'static',
      })
    }
    const registered = new Set(rows.map((row) => row.name))
    for (const tool of built) {
      if (registered.has(tool.name)) continue
      out.push(describeTool(family, connectorId, tool))
    }
  }
  return out
}

function describeTool(family: ProviderFamily, connectorId: string, tool: Tool): ToolDescriptor {
  const schema = toolInputJsonSchema(tool)
  return {
    name: tool.name,
    description: tool.description,
    family,
    connectorId,
    classification: tool.isReadOnly ? 'read' : 'write',
    defaultPolicy: tool.requiresConfirmation ? 'ask' : 'allow',
    requiresConfirmation: tool.requiresConfirmation,
    inputSchema: { kind: 'static', family, toolName: tool.name, ...(schema ? { schema } : {}) },
    origin: 'static',
  }
}

export function describeBuiltTools(family: ProviderFamily, connectorId: string, tools: readonly Tool[]): ToolDescriptor[] {
  return tools.map((tool) => describeTool(family, connectorId, tool))
}
