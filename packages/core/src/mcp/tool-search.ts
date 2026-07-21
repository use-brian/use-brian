/**
 * MCP tool search — Pattern E adapted for Gemini.
 *
 * Instead of N gateway tools (one per connector), the entire MCP surface
 * is exposed via exactly 2 tools:
 *
 *   mcp_search  — keyword search across all connectors' tools
 *   mcp_call    — proxy a call to any discovered tool
 *
 * A progressive-discovery pattern adapted for Gemini, which lacks native
 * tool_reference blocks.
 *
 * Token cost: ~300 tokens (2 tool definitions) regardless of connector count.
 *
 * **Two kinds of sources feed the index** (PR #4 of token-cost reduction):
 *   - **Remote** — a discovered MCP server reachable over HTTP. `mcp_call`
 *     dispatches via the injected `callMcpTool(serverUrl, toolName, input)`.
 *   - **Local** — first-party connector tools (Google / GitHub / Notion /
 *     Fathom / KB). The `Tool` object travels intact through the index so
 *     `mcp_call` can fire its `requiresConfirmation` / `resolveConfirmation`
 *     / `describeConfirmation` hooks and the unified-approvals flow with the
 *     **canonical underlying tool name** (not "mcp_call"). Path B durability
 *     is preserved via `context.onInnerAwaitingApproval`.
 *
 * See docs/architecture/integrations/mcp.md.
 */

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { classifyTool, defaultPolicy } from './classifier.js'
import { mcpResultToToolResult } from './tool-result.js'
import { jsonSchemaFromZod } from '../engine/query-loop.js'
import { declinedToolResult, timedOutToolResult } from '../engine/decline-copy.js'
import type { EngineHooks, PreToolUseDirective } from '../engine/hooks.js'
import type { McpSettingsStore, McpServerConfig, McpToolInfo } from './types.js'

// ── Source types ──────────────────────────────────────────────

/**
 * Remote source — a discovered MCP server. `mcp_call` dispatches via
 * `callMcpTool(serverUrl, toolName, input)` and applies the classifier-
 * based policy gate (L1 + L2) since we have no first-party metadata on
 * unknown tools.
 */
export type RemoteSource = {
  kind: 'remote'
  server: McpServerConfig
  serverUrl: string
  callMcpTool: (serverUrl: string, toolName: string, input: Record<string, unknown>, headerOverrides?: Record<string, string>) => Promise<unknown>
}

/**
 * Local source — first-party tools whose `Tool` objects carry their own
 * `requiresConfirmation` / `resolveConfirmation` / `describeConfirmation`
 * / `allowPersistentApproval` / capability-grant wrappers. `mcp_call`
 * defers to those hooks instead of the classifier-based policy gate, and
 * fires the unified `pending_approvals` + `session_resume_points` flow
 * with the **canonical underlying tool name**.
 *
 * `serverName` is the connector grouping (e.g. 'google', 'github',
 * 'notion', 'fathom', 'knowledge') — the model uses it as `server` in
 * `mcp_call({server, tool, args})`.
 */
export type LocalSource = {
  kind: 'local'
  serverName: string
  tools: Tool[]
}

export type ToolSource = RemoteSource | LocalSource

// Opaque short id for a pending confirmation. Must stay short enough that
// `mcp_confirm:<id>:always_allow` fits in Telegram's 64-byte callback_data
// cap (16 hex chars → 41 bytes total, comfortably under). 64-bit entropy is
// enough — the id only needs to be unique among in-flight confirmations.
function mintConfirmId(): string {
  return randomBytes(8).toString('hex')
}

// ── Search index ──────────────────────────────────────────────

type IndexedToolBase = {
  /** Connector grouping name — `server` in `mcp_call` invocations. */
  server: string
  /** Canonical tool name as the model sees it after a `mcp_search` hit. */
  toolName: string
  description: string
  /** JSON-Schema shape used by the search result formatter. */
  inputSchema: Record<string, unknown>
  /** Lowercased tokens from name + description for matching. */
  tokens: string[]
}

type RemoteIndexedTool = IndexedToolBase & {
  kind: 'remote'
  serverUrl: string
  /** Original MCP metadata (kept for any code that legacy-typed on `.tool`). */
  toolInfo: McpToolInfo
}

type LocalIndexedTool = IndexedToolBase & {
  kind: 'local'
  /** The actual `Tool` object — execute, hooks, capability wrappers all intact. */
  tool: Tool
}

type IndexedTool = RemoteIndexedTool | LocalIndexedTool

export type McpToolIndex = {
  entries: IndexedTool[]
  /** Server name → connector summary (for the search tool description) */
  serverSummaries: Map<string, string>
}

/** Tokenize a tool name + description for the keyword search index. */
function tokenize(name: string, description: string): string[] {
  const nameTokens = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
  const descTokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 2) // drop short words
  return [...new Set([...nameTokens, ...descTokens])]
}

/**
 * Build a searchable index from a mix of remote MCP servers and local
 * first-party tool sources. Called once per request after all sources
 * are resolved.
 */
export function buildToolIndex(sources: ToolSource[]): McpToolIndex {
  const entries: IndexedTool[] = []
  const serverSummaries = new Map<string, string>()

  for (const source of sources) {
    if (source.kind === 'remote') {
      const { server } = source
      serverSummaries.set(server.name, summarizeCapabilities(server.tools.map((t) => t.name)))

      for (const tool of server.tools) {
        entries.push({
          kind: 'remote',
          server: server.name,
          serverUrl: source.serverUrl,
          toolName: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          toolInfo: tool,
          tokens: tokenize(tool.name, tool.description),
        })
      }
      continue
    }

    // Local source
    serverSummaries.set(source.serverName, summarizeCapabilities(source.tools.map((t) => t.name)))

    for (const tool of source.tools) {
      // Derive JSON-Schema shape for the search result preview. Zod inputs
      // run through the in-tree converter (same one Gemini sees for direct-
      // injected tools, so the model's mental model is uniform across the
      // search pattern and the legacy direct-injection path).
      const inputSchema = tool.inputSchema?._def
        ? (jsonSchemaFromZod(tool.inputSchema) as unknown as Record<string, unknown>)
        : {}

      entries.push({
        kind: 'local',
        server: source.serverName,
        toolName: tool.name,
        description: tool.description,
        inputSchema,
        tool,
        tokens: tokenize(tool.name, tool.description),
      })
    }
  }

  return { entries, serverSummaries }
}

/**
 * Simple term-matching search. Scores each tool by how many query terms
 * appear in its token set. Name matches are weighted 2x over description.
 */
function searchIndex(index: McpToolIndex, query: string, limit: number = 8): IndexedTool[] {
  const queryTerms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 1)

  if (queryTerms.length === 0) {
    // Empty query — return a sample from each server
    const seen = new Set<string>()
    const results: IndexedTool[] = []
    for (const entry of index.entries) {
      if (!seen.has(entry.server)) {
        seen.add(entry.server)
        results.push(...index.entries.filter((e) => e.server === entry.server).slice(0, 3))
      }
      if (results.length >= limit) break
    }
    return results.slice(0, limit)
  }

  const scored = index.entries.map((entry) => {
    let score = 0
    const nameStr = entry.toolName.toLowerCase().replace(/_/g, ' ')
    const descStr = entry.description.toLowerCase()

    for (const term of queryTerms) {
      // Name match: 3 points (exact substring match)
      if (nameStr.includes(term)) score += 3
      // Description match: 1 point
      else if (descStr.includes(term)) score += 1
      // Token overlap: 0.5 points
      else if (entry.tokens.some((t) => t.includes(term) || term.includes(t))) score += 0.5
    }
    return { entry, score }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry)
}

/** Summarize a connector's capabilities by grouping tool names into verb categories. */
function summarizeCapabilities(toolNames: string[]): string {
  const groups = new Map<string, string[]>()
  for (const name of toolNames) {
    // Take the leading lowercase prefix as the verb (works for both
    // snake_case `search_repositories` and camelCase `googleCalendarCreateEvent`).
    const verb = name.split(/[_A-Z]/)[0]?.toLowerCase() || 'other'
    const existing = groups.get(verb) ?? []
    existing.push(name)
    groups.set(verb, existing)
  }

  const parts: string[] = []
  for (const [verb, names] of groups) {
    if (names.length <= 3) {
      parts.push(names.join(', '))
    } else {
      parts.push(`${verb}_* (${names.length} tools)`)
    }
  }
  return parts.join(', ')
}

/** Format a tool entry for the search result (includes schema). */
function formatToolResult(entry: IndexedTool): string {
  const schema = entry.inputSchema
  const hasParams = schema && typeof schema === 'object' && Object.keys(schema).length > 0

  let schemaStr = ''
  if (hasParams) {
    // Extract just the properties for a compact display
    const props = (schema as Record<string, unknown>).properties as Record<string, unknown> | undefined
    const required = (schema as Record<string, unknown>).required as string[] | undefined
    if (props) {
      const paramParts = Object.entries(props).map(([name, def]) => {
        const typeDef = def as Record<string, unknown>
        const type = typeDef.type ?? 'any'
        const desc = typeDef.description ? ` — ${typeDef.description}` : ''
        const req = required?.includes(name) ? '' : '?'
        return `    ${name}${req}: ${type}${desc}`
      })
      schemaStr = `\n  Parameters:\n${paramParts.join('\n')}`
    }
  }

  return `[${entry.server}] ${entry.toolName}: ${entry.description}${schemaStr}`
}

// ── Tool factories ────────────────────────────────────────────

/**
 * Create the two MCP tools (search + call) from a built tool index.
 *
 * These two tools replace all per-connector gateways:
 * - `mcp_search`: keyword search across all connectors
 * - `mcp_call`: proxy execution with policy enforcement
 */
export function createMcpSearchTools(params: {
  index: McpToolIndex
  settingsStore: McpSettingsStore
  assistantId: string
  appLevelAssistantId?: string
  userId: string
  /**
   * Default remote dispatcher. Used when an entry has `kind: 'remote'` but
   * no per-entry `callMcpTool` was provided at index-build time (every
   * remote entry today carries one, so this is a fallback for safety).
   */
  callMcpTool: (serverUrl: string, toolName: string, input: Record<string, unknown>, headerOverrides?: Record<string, string>) => Promise<unknown>
  /**
   * Optional tool-use interception (remote MCP only). `preToolUse` fires
   * right before the wire call (inject/overwrite headers, rewrite args, or
   * block); `postToolUse` observes the result. Unset in the open build.
   * See `docs/architecture/engine/tool-hooks.md`.
   */
  hooks?: EngineHooks
}): Tool[] {
  const { index, settingsStore, assistantId, appLevelAssistantId, userId, callMcpTool, hooks } = params

  // ── Lookup: server:toolName → IndexedTool ─────────────────────
  const entryByKey = new Map<string, IndexedTool>()
  for (const entry of index.entries) {
    entryByKey.set(`${entry.server}:${entry.toolName}`, entry)
  }

  // ── Session-level policy tracking ─────────────────────────────
  // Once a tool is blocked by policy or denied by user, it's added to
  // blockedTools. mcp_search filters these out so the model never sees
  // them again — deny = permanent, don't retry.
  // Once a tool is approved (allow or always_allow), it's added to
  // allowedTools so we skip confirmation for the rest of the session.
  const blockedTools = new Set<string>() // "server:toolName"
  const allowedTools = new Set<string>() // "server:toolName"

  // Build the connector summary for the search tool description
  const connectorList = Array.from(index.serverSummaries.entries())
    .map(([name, caps]) => `${name} (${caps})`)
    .join('; ')

  const totalTools = index.entries.length

  const searchTool = buildTool({
    name: 'mcp_search',
    description: `Search across ${totalTools} tools from connected services. Returns matching tools with descriptions and parameter schemas. Connected: ${connectorList}.`,
    inputSchema: z.object({
      query: z.string().describe('Search query — describe what you want to do (e.g. "get DRep voting history", "search proposals")'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    requiresConfirmation: false,

    async execute(input) {
      const { query } = input as { query: string }
      const results = searchIndex(index, query)
        .filter((entry) => !blockedTools.has(`${entry.server}:${entry.toolName}`))

      if (results.length === 0) {
        return {
          data: `No tools found matching "${query}". Try broader terms or different keywords.\n\nAvailable connectors: ${Array.from(index.serverSummaries.keys()).join(', ')}`,
        }
      }

      const formatted = results.map(formatToolResult).join('\n\n')
      return {
        data: `Found ${results.length} matching tools:\n\n${formatted}\n\nUse mcp_call with server, tool, and args to execute.`,
      }
    },
  })

  const callTool = buildTool({
    name: 'mcp_call',
    description: 'Execute a tool on a connected service. Use mcp_search first to find the right tool and its parameters.',
    inputSchema: z.object({
      server: z.string().describe('Server name (from mcp_search results, e.g. "google", "github", "Cardano Onchain Governance")'),
      tool: z.string().describe('Tool name (from mcp_search results, e.g. "googleCalendarCreateEvent", "get_drep_profile")'),
      // Gemini Flash variants occasionally emit `args` as a JSON-encoded
      // string instead of a structured object. Preprocess attempts a
      // single JSON.parse before validation so the model self-recovers
      // instead of looping on "Expected object, received string".
      args: z.preprocess(
        (v) => {
          if (typeof v !== 'string') return v
          try { return JSON.parse(v) } catch { return v }
        },
        z.record(z.unknown()).optional(),
      ).describe('Arguments matching the tool\'s parameter schema'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: false,

    async execute(input, context) {
      const { server, tool, args } = input as {
        server: string
        tool: string
        args?: Record<string, unknown>
      }

      // Resolve entry
      const toolEntry = entryByKey.get(`${server}:${tool}`)
      if (!toolEntry) {
        const available = Array.from(index.serverSummaries.keys()).join(', ')
        return {
          data: `ERROR: unknown tool "${tool}" on server "${server}". Available servers: ${available}. Use mcp_search to discover tools.`,
          isError: true,
        }
      }

      const toolKey = `${server}:${tool}`

      // Fast-reject tools already blocked in this session — no need
      // to re-evaluate policy (deny-first).
      if (blockedTools.has(toolKey)) {
        return {
          data: `ERROR: "${tool}" is blocked for this session. Capability unavailable.`,
          isError: true,
        }
      }

      // ── Dispatch by source kind ───────────────────────────────
      if (toolEntry.kind === 'local') {
        return dispatchLocal({
          entry: toolEntry,
          server,
          tool,
          toolKey,
          args: args ?? {},
          context,
          blockedTools,
          allowedTools,
        })
      }

      return dispatchRemote({
        entry: toolEntry,
        server,
        tool,
        toolKey,
        args: args ?? {},
        context,
        blockedTools,
        allowedTools,
        settingsStore,
        assistantId,
        appLevelAssistantId,
        userId,
        callMcpTool,
        hooks,
      })
    },
  })

  return [searchTool, callTool]
}

// ── Dispatch: remote source ───────────────────────────────────

async function dispatchRemote(params: {
  entry: RemoteIndexedTool
  server: string
  tool: string
  toolKey: string
  args: Record<string, unknown>
  context: import('../tools/types.js').ToolContext
  blockedTools: Set<string>
  allowedTools: Set<string>
  settingsStore: McpSettingsStore
  assistantId: string
  appLevelAssistantId?: string
  userId: string
  callMcpTool: (serverUrl: string, toolName: string, input: Record<string, unknown>, headerOverrides?: Record<string, string>) => Promise<unknown>
  hooks?: EngineHooks
}) {
  const {
    entry, server, tool, toolKey, args, context,
    blockedTools, allowedTools,
    settingsStore, assistantId, appLevelAssistantId, userId, callMcpTool, hooks,
  } = params

  // Check classification + policy (strictest of L1 app-level + L2 assistant-level)
  const classification = classifyTool(tool, entry.description)
  const fallbackPolicy = defaultPolicy(classification)

  let effectivePolicy = fallbackPolicy

  if (appLevelAssistantId) {
    const l1 = await settingsStore.getPolicy({
      assistantId: appLevelAssistantId, userId,
      serverName: server, toolName: tool,
    })
    const l2 = await settingsStore.getPolicy({
      assistantId, userId,
      serverName: server, toolName: tool,
    })
    const appPolicy = l1?.policy ?? fallbackPolicy
    const asstPolicy = l2?.policy ?? fallbackPolicy
    const STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
    effectivePolicy = (STRICTNESS[appPolicy] ?? 0) >= (STRICTNESS[asstPolicy] ?? 0) ? appPolicy : asstPolicy
  } else {
    const setting = await settingsStore.getPolicy({
      assistantId, userId,
      serverName: server, toolName: tool,
    })
    effectivePolicy = setting?.policy ?? fallbackPolicy
  }

  if (effectivePolicy === 'block') {
    blockedTools.add(toolKey)
    return {
      data: `ERROR: "${tool}" is blocked by policy. Capability unavailable.`,
      isError: true,
    }
  }

  // ── Confirmation gate for 'ask' policy ──────────────────────
  // 'ask' = pause, show user the
  // tool details, wait for decision. Uses confirmationResolver and
  // notifyConfirmationRequired from ToolContext (threaded from query
  // loop → tool executor → execute()). Decisions persist for the
  // session (allow/deny) or permanently (always_allow/always_deny).
  if (effectivePolicy === 'ask' && !allowedTools.has(toolKey)) {
    const resolver = context?.confirmationResolver
    const notify = context?.notifyConfirmationRequired
    if (resolver && notify) {
      const confirmId = mintConfirmId()

      notify({
        toolCallId: confirmId,
        toolName: tool,
        serverName: server,
        input: args,
        classification,
        description: entry.description,
        allowPersistentApproval: true,
      })

      try {
        const timeoutMs = context?.confirmationTimeoutMs ?? 300_000
        const decision = await resolver.waitForDecision(confirmId, timeoutMs)

        if (decision === 'deny') {
          blockedTools.add(toolKey)
          return {
            data: declinedToolResult(tool),
            isError: true,
          }
        }

        if (decision === 'always_deny') {
          blockedTools.add(toolKey)
          settingsStore.setPolicy({
            assistantId, userId,
            serverName: server, toolName: tool,
            policy: 'block', classification,
          }).catch((err) => console.debug('Failed to persist always_deny:', err))
          return {
            data: `ERROR: user permanently blocked "${tool}". Capability unavailable.`,
            isError: true,
          }
        }

        if (decision === 'always_allow') {
          allowedTools.add(toolKey)
          settingsStore.setPolicy({
            assistantId, userId,
            serverName: server, toolName: tool,
            policy: 'allow', classification,
          }).catch((err) => console.debug('Failed to persist always_allow:', err))
          // Fall through to execution
        }

        if (decision === 'allow') {
          allowedTools.add(toolKey)
          // Fall through to execution
        }
      } catch {
        // Timeout — treat as deny for this session
        blockedTools.add(toolKey)
        return {
          data: `Tool confirmation timed out for "${tool}". Execution skipped. Respond to the user with what you can do instead.`,
          isError: true,
        }
      }
    } else {
      // No confirmation infrastructure available (e.g. cron/scheduled jobs).
      // Reject execution — 'ask' policy must not be silently bypassed.
      return {
        data: `ERROR: "${tool}" requires user confirmation (policy: ask) but no confirmation channel is available in this context. The tool was NOT executed. If this is a scheduled job, the user must pre-approve this tool (set policy to 'allow') before it can run unattended.`,
        isError: true,
      }
    }
  }

  // ── Preflight hook (remote MCP only) ────────────────────────
  // Fires AFTER the policy/confirmation gate, immediately before the wire
  // call — so it sees only authorized calls and can still inject/overwrite
  // outbound headers, rewrite args, or block. Fail-closed: a throwing
  // preToolUse skips the call (a gate that errors must not fail open). The
  // override (if any) is the only thing that threads a 4th arg into
  // callMcpTool, so the no-hook path stays a 3-arg call byte-for-byte.
  // See docs/architecture/engine/tool-hooks.md.
  let effInput = args
  let headerOverride: Record<string, string> | undefined
  if (hooks?.preToolUse) {
    let directive: PreToolUseDirective | void
    try {
      directive = await hooks.preToolUse({
        source: 'remote_mcp',
        serverUrl: entry.serverUrl,
        serverName: server,
        toolName: tool,
        input: args,
        userId,
        assistantId,
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
      })
    } catch (err) {
      return {
        data: `ERROR: preflight hook errored for "${tool}"; call not executed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
    if (directive?.action === 'block') {
      return {
        data: `ERROR: "${tool}" was blocked by a preflight hook: ${directive.reason}`,
        isError: true,
      }
    }
    if (directive?.action === 'modify') {
      if (directive.input) effInput = directive.input
      if (directive.headers) headerOverride = directive.headers
    }
  }

  const startedAt = Date.now()
  try {
    const result = headerOverride
      ? await callMcpTool(entry.serverUrl, tool, effInput, headerOverride)
      : await callMcpTool(entry.serverUrl, tool, effInput)

    // Track usage
    settingsStore.recordUsage({
      assistantId, userId,
      serverName: server,
      toolName: tool,
      allowed: true,
    }).catch((err) => console.debug('MCP usage tracking failed:', err))

    // Post-call observation hook. Swallow its errors — the call already ran.
    if (hooks?.postToolUse) {
      try {
        await hooks.postToolUse({
          source: 'remote_mcp',
          serverUrl: entry.serverUrl,
          serverName: server,
          toolName: tool,
          input: effInput,
          userId,
          assistantId,
          sessionId: context.sessionId,
          workspaceId: context.workspaceId,
          result: { data: result, isError: false },
          elapsedMs: Date.now() - startedAt,
        })
      } catch (err) {
        console.warn(`[mcp_call:dispatchRemote] postToolUse hook failed for ${tool}:`, err)
      }
    }

    // Lift any inline image content onto ToolResult.images so the model sees it.
    return mcpResultToToolResult(result)
  } catch (err) {
    return {
      data: `MCP tool ${tool} failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

// ── Dispatch: local source ────────────────────────────────────

/**
 * Route a `mcp_call` invocation to a first-party `Tool` object. Defers
 * to the underlying tool's own `requiresConfirmation` / `resolveConfirmation`
 * / `describeConfirmation` hooks instead of the classifier-based policy
 * gate — these tools already encode their own safety semantics (capability
 * grants, audit wrappers, sensitivity gates).
 *
 * When the tool needs confirmation, fires the unified-approvals flow with
 * the **canonical underlying tool name** so:
 *   - the `pending_approvals` row reads `tool_name='googleCalendarCreateEvent'`
 *     (not 'mcp_call'),
 *   - the chat UI's `enrichConfirmation(toolName, input)` lookup hits the
 *     right enricher (Gmail/GCal pre-fetch their summaries by canonical
 *     name in the inject layer),
 *   - Path B's `session_resume_points` captures the canonical name +
 *     frozen input via `context.onInnerAwaitingApproval`, so a Cloud Run
 *     restart replays the right tool.
 */
async function dispatchLocal(params: {
  entry: LocalIndexedTool
  server: string
  tool: string
  toolKey: string
  args: Record<string, unknown>
  context: import('../tools/types.js').ToolContext
  blockedTools: Set<string>
  allowedTools: Set<string>
}) {
  const { entry, server, tool, toolKey, args, context, blockedTools, allowedTools } = params
  const targetTool = entry.tool

  // Resolve confirmation requirement — same logic the executor uses for
  // direct-injected tools (`resolveConfirmation` overrides `requiresConfirmation`).
  let needsConfirmation = targetTool.resolveConfirmation
    ? await targetTool.resolveConfirmation(context, args)
    : targetTool.requiresConfirmation

  if (needsConfirmation && allowedTools.has(toolKey)) {
    // User said "always allow" earlier in this session — bypass.
    needsConfirmation = false
  }

  if (needsConfirmation) {
    const resolver = context?.confirmationResolver
    const notify = context?.notifyConfirmationRequired

    if (!resolver || !notify) {
      // No confirmation channel — fail closed. Matches the tool-executor
      // direct-injection behavior for `requiresConfirmation` tools.
      return {
        data: `ERROR: "${tool}" requires user confirmation but no confirmation channel is available in this context. The tool was NOT executed. If this is a scheduled job, pre-approve via the appropriate per-action grant before it can run unattended.`,
        isError: true,
      }
    }

    // Producer-side describe — pre-resolves friendly text now so the
    // unified-approvals row / Path B checkpoint carry the rendered view.
    let displayLines: string[] | undefined
    if (targetTool.describeConfirmation) {
      try {
        const lines = await targetTool.describeConfirmation(args, context)
        if (lines && lines.length > 0) displayLines = lines
      } catch (err) {
        console.debug(`[mcp_call:dispatchLocal] describeConfirmation failed for ${tool}:`, err)
      }
    }

    const confirmId = mintConfirmId()
    const timeoutMs = context?.confirmationTimeoutMs ?? 300_000

    // Q10 unification — persist a `kind='tool_invocation'` row with the
    // **canonical underlying tool name**. Fail-OPEN so a DB blip doesn't
    // block the user; Path A in-memory resolver still works.
    let approvalId: string | undefined
    if (context.createToolInvocationApproval) {
      const expiresAt = new Date(Date.now() + timeoutMs)
      try {
        approvalId = await context.createToolInvocationApproval({
          toolName: tool,
          toolInput: args,
          description: targetTool.description,
          displayLines,
          allowPersistentApproval: targetTool.allowPersistentApproval ?? false,
          expiresAt,
        })
      } catch (err) {
        console.warn(
          `[mcp_call:dispatchLocal] approval row creation failed for ${tool}; continuing with in-memory confirmation only:`,
          err,
        )
      }

      // Path B durability — chat route writes session_resume_points off
      // this so a Cloud Run restart mid-confirmation replays the right
      // tool with its canonical name. Mirrors `options.onAwaitingApproval`
      // in the tool-executor for direct-injected tools.
      if (approvalId && context.onInnerAwaitingApproval) {
        context.onInnerAwaitingApproval({
          approvalId,
          toolCallId: confirmId,
          toolName: tool,
          toolInput: args,
          describeText:
            displayLines && displayLines.length > 0
              ? displayLines.join('\n')
              : targetTool.description,
          expiresAt,
        })
      }
    }

    notify({
      toolCallId: confirmId,
      toolName: tool,
      serverName: server,
      input: args,
      classification: null,
      description: targetTool.description,
      displayLines,
      allowPersistentApproval: targetTool.allowPersistentApproval ?? false,
      approvalId,
    })

    try {
      const decision = await resolver.waitForDecision(confirmId, timeoutMs)

      if (decision === 'deny' || decision === 'always_deny') {
        blockedTools.add(toolKey)
        return {
          data: declinedToolResult(tool),
          isError: true,
        }
      }

      if (decision === 'always_allow') {
        // Built-in tools default to `allowPersistentApproval: false` —
        // each call targets a distinct entity and "always allow" would
        // be misleading. The channel UI surfaces Always Allow only when
        // `allowPersistentApproval=true`, so seeing it here means the
        // user explicitly opted in. Honor for the session only; durable
        // persistence is the per-tool job (e.g. `assistant_connector_grants`).
        allowedTools.add(toolKey)
      }
      // 'allow' or 'always_allow' — fall through to execution
    } catch {
      blockedTools.add(toolKey)
      return {
        data: timedOutToolResult(tool),
        isError: true,
      }
    }
  }

  // Execute the underlying tool. All capability gates, audit wrappers,
  // and sensitivity checks live inside its `execute()` — `mcp_call` is a
  // transparent dispatcher at this point.
  return targetTool.execute(args, context)
}
