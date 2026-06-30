/**
 * Engine hooks — typed interception around tool use.
 *
 * A composition-root port (the platform injects it; the open build leaves it
 * unset). Today it fires around **remote MCP** tool calls only: `preToolUse`
 * runs right before the wire call and can inject/overwrite outbound HTTP
 * headers, rewrite args, or block the call; `postToolUse` observes the
 * result. The shape is intentionally general — `source` reserves room for
 * built-in / local firing sites and a future all-tools PreToolUse at the
 * executor — but the wiring is remote-MCP-only.
 *
 * Header overrides produced here are re-validated (RFC 7230 / no CRLF) and
 * merged over the connector's stored-credential headers at the transport
 * boundary, the override winning. See `packages/api/src/mcp/auth-headers.ts`
 * (`mergeValidatedHeaders`) and `docs/architecture/engine/tool-hooks.md`.
 */

/**
 * What a tool-use hook sees. `source` is `'remote_mcp'` for every call today.
 * All identity fields are request-scoped (threaded from the chat route's
 * `ToolContext` + the per-turn `injectMcpTools` identity).
 */
export type ToolUseHookContext = {
  userId: string
  assistantId: string
  sessionId: string
  workspaceId?: string | null
  /** Only `'remote_mcp'` today; reserves built-in / local firing sites later. */
  source: 'remote_mcp'
  /** Remote MCP server URL — the header-override join key. */
  serverUrl: string
  /** Connector grouping the model passed as `server` in `mcp_call`. */
  serverName: string
  /** Canonical underlying tool name (never `'mcp_call'`). */
  toolName: string
  /** Args the tool will run with (post-`modify` value for `postToolUse`). */
  input: Record<string, unknown>
}

/**
 * What `preToolUse` returns. `void` / `undefined` / `{ action: 'continue' }`
 * all mean "proceed unchanged".
 *  - `modify` — merge `headers` over the stored-credential headers (override
 *    wins, re-validated) and/or replace `input`.
 *  - `block`  — skip the call; the model receives an error `tool_result`
 *    carrying `reason`.
 */
export type PreToolUseDirective =
  | { action: 'continue' }
  | { action: 'modify'; headers?: Record<string, string>; input?: Record<string, unknown> }
  | { action: 'block'; reason: string }

export type PostToolUseHookContext = ToolUseHookContext & {
  result: { data: unknown; isError: boolean }
  elapsedMs: number
}

/**
 * Optional interception port threaded into `createMcpSearchTools`.
 *
 * Failure semantics (see `docs/architecture/engine/tool-hooks.md`):
 *  - `preToolUse` throwing → **fail-closed**: the call is NOT executed and
 *    the model gets an error result. A hook is a gate; a gate that errors
 *    must not fail open. A header-only hook that wants degrade-to-continue
 *    should catch its own errors and return `{ action: 'continue' }`.
 *  - `postToolUse` throwing → swallowed + warned; the call already ran, so
 *    an observation failure must not undo it.
 */
export type EngineHooks = {
  preToolUse?: (
    ctx: ToolUseHookContext,
  ) => Promise<PreToolUseDirective | void> | PreToolUseDirective | void
  postToolUse?: (ctx: PostToolUseHookContext) => Promise<void> | void
}
