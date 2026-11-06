/**
 * Actionable input validation for the MCP servers Brian PROVIDES.
 *
 * `McpServer` validates a tool call's arguments against the registered
 * `inputSchema` BEFORE our handler runs (`validateToolInput` in
 * `@modelcontextprotocol/sdk` server/mcp.js). On failure it renders
 * `getParseErrorMessage(error)`, which prefers `error.message` — and zod v3's
 * `ZodError.message` is `JSON.stringify(issues, null, 2)`. So an external
 * agent that sends one bad `status` to `listTasks` gets back ~1k chars of
 * nested `unionErrors` JSON, prefixed `MCP error -32602: Input validation
 * error: Invalid arguments for tool listTasks:` — the same recursive shape
 * `formatToolError` was written to cap on the chat path after the 2026-06-01
 * incident. The chat executor is protected; the MCP pre-handler path was not.
 *
 * The stateless MCP transport calls this validator before dispatch. It keeps
 * the full native schema (including unions/refinements), and presents compact
 * errors while retaining all original issues. Never mutate a shared schema.
 *
 * Component tag: [COMP:api/brain-mcp-input-validation].
 */

import { z } from 'zod'
import { formatToolError } from '@use-brian/core'

/** What the SDK reads off a failed parse: `.message` first, `.issues` as fallback. */
type FriendlyFailure = {
  success: false
  error: { issues: z.ZodIssue[]; message: string }
}

/**
 * Wrap a tool's raw shape or native schema so a validation
 * failure reads as the chat executor's compact rendering.
 */
export function actionableInputSchema(input: z.ZodRawShape | z.ZodObject<z.ZodRawShape>, toolName: string): z.ZodObject<z.ZodRawShape>
export function actionableInputSchema(input: z.ZodRawShape | z.ZodTypeAny, toolName: string): z.ZodTypeAny
export function actionableInputSchema(
  input: z.ZodRawShape | z.ZodTypeAny,
  toolName: string,
): z.ZodTypeAny {
  const base = input instanceof z.ZodType ? input : z.object(input)
  // describe() returns a fresh instance of the same schema type, retaining
  // object strictness, refinements and union branches without shared mutation.
  const schema = base.describe(base.description ?? '')
  const parseAsync = schema.safeParseAsync.bind(schema)
  const parseSync = schema.safeParse.bind(schema)

  const friendly = (err: z.ZodError): FriendlyFailure => ({
    success: false,
    error: {
      issues: err.issues,
      message: `${formatToolError(err)}\nFix the named field(s) and call \`${toolName}\` again — the same arguments will fail the same way.`,
    },
  })

  Object.assign(schema, {
    safeParseAsync: async (data: unknown) => {
      const r = await parseAsync(data)
      return r.success ? r : friendly(r.error)
    },
    safeParse: (data: unknown) => {
      const r = parseSync(data)
      return r.success ? r : friendly(r.error)
    },
  })
  return schema
}
