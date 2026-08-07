/**
 * AI Engines MCP — the HTTP surface's thin adapter.
 *
 * The engine logic itself (per-engine `callOnce`, batch / samples / checkFor
 * / truncation / concurrency, the GSC service-account JWT) lives ONCE in
 * `@use-brian/core` → `engines/ask-engines.ts`, shared with the in-process
 * base tools. This file adds only what the HTTP surface owns:
 *
 *   - the MCP `CallToolResult` shape,
 *   - env parsing for the daily call ceiling,
 *   - the ceiling itself.
 *
 * The ceiling belongs HERE and not in core: this endpoint has no workspace
 * identity, so its spend is invisible to credit metering and a runaway needs
 * a server-side breaker. The in-process tools carry no ceiling — workspace
 * budget/credit enforcement is the guard there.
 *
 * Spec: docs/architecture/integrations/engines-mcp.md. [COMP:api/engines-mcp]
 */

import type { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  createEngineAskers,
  createGscQuerier,
  EngineInputError,
  EngineBudgetError,
  ASK_INPUT_SHAPE,
  GSC_INPUT_SHAPE,
  type AskArgs,
  type EnginesEnv,
  type GscQueryArgs,
} from '@use-brian/core'

export type { EnginesEnv }

/** Default daily ceiling across all tools (override: ENGINES_DAILY_CALL_CAP; `0` disables). */
const DEFAULT_DAILY_CALL_CAP = 200

export type EngineTool = {
  name: string
  description: string
  inputSchema: Record<string, z.ZodType>
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>
}

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: body }], isError }
}

/** Render a caller-facing refusal verbatim; anything else as a coded failure. */
function toolError(toolName: string, err: unknown): CallToolResult {
  if (err instanceof EngineInputError || err instanceof EngineBudgetError) {
    return text(err.message, true)
  }
  return text(`${toolName} failed: ${err instanceof Error ? err.message : 'unknown_error'}`, true)
}

/**
 * Build the engine tools available under the given env. Only tools whose
 * credential is present are returned — absent env, absent tool, nothing to
 * govern. `fetchImpl` is injectable for tests.
 */
export function createEngineTools(
  env: EnginesEnv,
  fetchImpl: typeof fetch = fetch,
): EngineTool[] {
  const tools: EngineTool[] = []

  // ── Shared daily call ceiling (runaway breaker, not a usage meter) ─────
  // Unset/invalid → safety default; an explicit `0` disables the ceiling —
  // the operator's deliberate opt-out, e.g. heavy multi-panel use.
  const capRaw = (env.ENGINES_DAILY_CALL_CAP ?? '').trim()
  const capParsed = parseInt(capRaw, 10)
  const dailyCap =
    capRaw === '0'
      ? Infinity
      : Number.isFinite(capParsed) && capParsed > 0
        ? capParsed
        : DEFAULT_DAILY_CALL_CAP
  let counterDay = ''
  let counterCalls = 0
  function takeCallBudget(): string | null {
    const day = new Date().toISOString().slice(0, 10)
    if (day !== counterDay) {
      counterDay = day
      counterCalls = 0
    }
    if (counterCalls >= dailyCap) {
      return (
        `Daily engine-call ceiling reached (${dailyCap} calls this UTC day). ` +
        'No further upstream calls until tomorrow — raise ENGINES_DAILY_CALL_CAP only deliberately.'
      )
    }
    counterCalls += 1
    return null
  }

  for (const asker of createEngineAskers(env, fetchImpl)) {
    tools.push({
      name: asker.name,
      description: asker.description,
      inputSchema: { ...ASK_INPUT_SHAPE },
      handler: async (args) => {
        try {
          const run = await asker.run(args as AskArgs, takeCallBudget)
          return text(JSON.stringify(run.payload, null, 2), run.allFailed)
        } catch (err) {
          return toolError(asker.name, err)
        }
      },
    })
  }

  const gsc = createGscQuerier(env, fetchImpl)
  if (gsc) {
    tools.push({
      name: gsc.name,
      description: gsc.description,
      inputSchema: { ...GSC_INPUT_SHAPE },
      handler: async (args) => {
        try {
          return text(JSON.stringify(await gsc.query(args as GscQueryArgs, takeCallBudget), null, 2))
        } catch (err) {
          return toolError(gsc.name, err)
        }
      },
    })
  }

  return tools
}
