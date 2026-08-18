/**
 * Model-facing rendering of a third-party MCP tool failure —
 * `[COMP:mcp/errors]`.
 *
 * `mcp_call` (and the legacy gateway/connector paths) execute tools that
 * live on EXTERNAL MCP servers. When one throws, the raw `err.message` is
 * the third-party server's own text — often a bare code or a JSON fragment
 * that names neither whose error it is nor what to do. Wrap it so the model
 * knows: WHAT failed (server + tool), WHY-ish (the server's own words,
 * bounded), and the NEXT STEP (fix a named argument, or report — never loop
 * on an identical call). Mirrors `describeSlackError` in
 * `@use-brian/channels` for the first-party Slack client.
 */

import { formatToolError } from '../engine/tool-executor.js'

const MAX_UPSTREAM_CHARS = 600

export function describeMcpToolError(server: string, tool: string, err: unknown): string {
  // ZodErrors (a tool result schema re-parse, a bundled zod) collapse to
  // `path: message` lines instead of the issues-JSON blob.
  const raw = formatToolError(err)
  const bounded = raw.length > MAX_UPSTREAM_CHARS ? `${raw.slice(0, MAX_UPSTREAM_CHARS)}…` : raw
  return (
    `ERROR: the "${server}" MCP server failed to run "${tool}": ${bounded}\n` +
    'This is the third-party server\'s own error, not a Use Brian failure. ' +
    'If it names a bad argument or missing field, fix that and retry ONCE with the corrected input; ' +
    'otherwise report the error to the user — repeating the identical call will fail identically.'
  )
}
