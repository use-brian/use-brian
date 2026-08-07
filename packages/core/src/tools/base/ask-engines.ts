import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import {
  createEngineAskers,
  createGscQuerier,
  EngineInputError,
  ASK_INPUT_SHAPE,
  GSC_INPUT_SHAPE,
  type EnginesEnv,
} from '../../engines/ask-engines.js'
import { encodeExternalCostMeta } from '../../billing/external-cost.js'
import { flatEngineCostUsd, engineCostModel } from '../../billing/engine-provider-rates.js'

/**
 * In-process engine observation tools — `askOpenAI`, `askGemini`,
 * `askPerplexity`, `askClaude`, `searchConsoleQuery`.
 *
 * Same shape as `webSearch`: a base tool that talks to a paid external API
 * and reports what it spent on `ToolResult.meta`, which the shared
 * external-cost recording seam turns into a `usage_tracking` row. The engine
 * logic itself is NOT here — it lives once in `engines/ask-engines.ts`, which
 * the HTTP MCP surface wraps too (see that module's header).
 *
 * Registered in `createBaseTools()` only when the matching `ENGINES_*`
 * credential is set — fail-closed, exactly like `xSearch`. Availability is
 * communicated by tool injection alone: nothing in Layer 1 names these tools,
 * so an assistant without the credential never hunts for them.
 *
 * No daily ceiling here, deliberately. That breaker exists on the HTTP
 * endpoint because it has no workspace identity; on this path the guard is
 * workspace budget and credit enforcement, which these very cost rows feed.
 *
 * See docs/architecture/integrations/engines-mcp.md → "In-process tools and
 * metering" and docs/architecture/platform/cost-and-pricing.md → "External
 * API cost tracking policy". [COMP:tools/ask-engines]
 */

/**
 * Batches are the reason this is not `webSearch`'s 15 s: one call can fan out
 * to questions x samples upstream requests at bounded concurrency, each with
 * its own 45 s ceiling. Generous enough for a full panel, still finite.
 */
const ENGINE_TOOL_TIMEOUT_MS = 240_000

const askInputSchema = z.object(ASK_INPUT_SHAPE)
const gscInputSchema = z.object(GSC_INPUT_SHAPE)

export function createEngineBaseTools(
  env: EnginesEnv = process.env as EnginesEnv,
  fetchImpl?: typeof fetch,
): Tool[] {
  const tools: Tool[] = []

  for (const asker of createEngineAskers(env, fetchImpl)) {
    tools.push(
      buildTool({
        name: asker.name,
        description: asker.description,
        inputSchema: askInputSchema,
        isConcurrencySafe: true,
        isReadOnly: true,
        timeoutMs: ENGINE_TOOL_TIMEOUT_MS,

        async execute(input) {
          let run
          try {
            // No budget hook: the ceiling belongs to the HTTP surface only.
            run = await asker.run(input)
          } catch (err) {
            // A caller-input refusal is the model's to fix, and cost nothing.
            if (err instanceof EngineInputError) return { data: err.message, isError: true }
            throw err
          }

          // Flat rate x the units that actually returned an answer. Units the
          // engine refused (quota, bad request) spent nothing and are not
          // billed, so a fully-failed call carries no cost meta at all.
          const meta =
            run.successfulUnits > 0
              ? {
                  engine: asker.engine,
                  engineUnits: run.successfulUnits,
                  ...encodeExternalCostMeta({
                    kind: 'flat',
                    model: engineCostModel(asker.engine),
                    flatCostUsd: flatEngineCostUsd(asker.engine) * run.successfulUnits,
                  }),
                }
              : undefined

          // Partial results are a success; only an all-units-failed run is an
          // error, matching what the MCP surface reports for the same run.
          return { data: run.payload, isError: run.allFailed, meta }
        },
      }),
    )
  }

  const gsc = createGscQuerier(env, fetchImpl)
  if (gsc) {
    tools.push(
      buildTool({
        name: gsc.name,
        description: gsc.description,
        inputSchema: gscInputSchema,
        isConcurrencySafe: true,
        isReadOnly: true,
        timeoutMs: ENGINE_TOOL_TIMEOUT_MS,

        async execute(input) {
          try {
            const data = await gsc.query(input)
            // Search Console is free; the $0 row is an audit trail, the same
            // convention `duckduckgo` follows in the search rates table.
            return {
              data,
              meta: encodeExternalCostMeta({
                kind: 'flat',
                model: engineCostModel('gsc'),
                flatCostUsd: 0,
              }),
            }
          } catch (err) {
            if (err instanceof EngineInputError) return { data: err.message, isError: true }
            return {
              data: `searchConsoleQuery failed: ${err instanceof Error ? err.message : 'unknown_error'}`,
              isError: true,
            }
          }
        },
      }),
    )
  }

  return tools
}
