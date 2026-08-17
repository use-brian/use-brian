import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import {
  createEngineAskers,
  createGscQuerier,
  EngineInputError,
  ASK_INPUT_SHAPE,
  GSC_INPUT_SHAPE,
  type AskPayload,
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

/** Credential / configuration rejections — no retry of any shape will clear these. */
const CONFIG_SHAPED = /status=40[13]|unauthor|invalid[_ ]api[_ ]key|api key|no_token|forbidden|permission|credential/i
/** Quota and ceiling refusals — the call is well-formed, the account is out of room. */
const QUOTA_SHAPED = /status=429|quota|rate.?limit|daily ceiling|insufficient[_ ]quota|billing/i
/** Blips a single retry can plausibly clear. */
const TRANSIENT_SHAPED = /status=5\d\d|timeout|timed out|fetch failed|socket hang up|ECONN|EAI_AGAIN|unparseable|network/i

/**
 * The all-units-failed account.
 *
 * `run.payload` on a fully-failed call is a nest of `{ error: … }` objects
 * with no diagnosis and no verdict — the model saw a JSON blob whose only
 * readable content was a raw `upstream_error status=401`, and its usual
 * response was to fire the same panel again. This renders one line per
 * question (with the distinct reasons and how many units each hit) and ONE
 * verdict derived from those reasons. Message first, structured payload after
 * (tool-executor.md → "Failure copy", D5), so nothing is lost.
 */
function describeAllFailed(toolName: string, payload: AskPayload): string {
  const reasons: string[] = []
  const lines = payload.results.map((r) => {
    const counts = new Map<string, number>()
    for (const a of r.answers) {
      const raw = 'error' in a ? a.error : undefined
      const reason = (raw ?? 'no answer returned').trim() || 'no answer returned'
      counts.set(reason, (counts.get(reason) ?? 0) + 1)
      reasons.push(reason)
    }
    const detail = [...counts.entries()]
      .map(([reason, n]) => (n > 1 ? `${reason} (x${n})` : reason))
      .join('; ')
    return `- "${r.question}": ${detail}`
  })

  const all = reasons.join(' ')
  const verdict = CONFIG_SHAPED.test(all)
    ? `This is a credentials/configuration problem with the ${payload.engine} key, not something the question can fix. Do NOT retry — tell the user the ${payload.engine} engine is unavailable until its API key is fixed.`
    : QUOTA_SHAPED.test(all)
      ? `The ${payload.engine} account is out of quota or rate-limited. Retrying now fails the same way — tell the user, or come back to it later with fewer questions/samples.`
      : TRANSIENT_SHAPED.test(all)
        ? 'These are transient upstream failures. Retry once; if the second attempt also returns nothing, tell the user rather than looping.'
        : 'Retrying the same questions unchanged is unlikely to help — tell the user what the engine reported.'

  return [
    `\`${toolName}\` got no answers back: every unit failed at ${payload.engine} (${payload.model}). Nothing was billed for this call.`,
    ...lines,
    ...(payload.note ? [`Note: ${payload.note}`] : []),
    verdict,
    `Full payload: ${JSON.stringify(payload)}`,
  ].join('\n')
}

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
            if (err instanceof EngineInputError) {
              return {
                data: `\`${asker.name}\` did not run: ${err.message} Nothing was asked and nothing was billed. Fix the named argument and call again — the same arguments will be refused the same way.`,
                isError: true,
              }
            }
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
          // Partial successes keep the structured payload verbatim — the
          // answers that DID come back are the point of the call.
          if (run.allFailed) {
            return { data: describeAllFailed(asker.name, run.payload), isError: true, meta }
          }
          return { data: run.payload, meta }
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
            if (err instanceof EngineInputError) {
              return {
                data: `${err.message} Fix the named argument and call again — the same arguments will be refused the same way. Nothing was queried.`,
                isError: true,
              }
            }
            const message = err instanceof Error ? err.message : 'unknown_error'
            const verdict = CONFIG_SHAPED.test(message)
              ? 'This is a credentials/configuration problem with the Search Console service account, not something the arguments can fix. Do NOT retry — tell the user Search Console is not connected properly.'
              : QUOTA_SHAPED.test(message)
                ? 'Search Console refused on quota or rate limits. Retrying now fails the same way — tell the user, or narrow the date range and try later.'
                : TRANSIENT_SHAPED.test(message)
                  ? 'This looks transient. Retry once; if it fails again, tell the user rather than looping.'
                  : 'Retrying the same arguments is unlikely to help — fix what the message names, or tell the user what Search Console reported.'
            return {
              data: `\`searchConsoleQuery\` returned no data: ${message}. ${verdict}`,
              isError: true,
            }
          }
        },
      }),
    )
  }

  return tools
}
