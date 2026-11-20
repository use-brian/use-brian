/**
 * AI Engines MCP — the HTTP surface's thin adapter.
 *
 * The engine logic itself (per-engine `callOnce`, batch / samples / checkFor
 * / truncation / concurrency) lives ONCE in
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
import { flatEngineCostUsd } from '@use-brian/core/billing/engine-provider-rates.js'
import {
  createEngineAskers,
  EngineInputError,
  EngineBudgetError,
  ASK_INPUT_SHAPE,
  type AskArgs,
  type EnginesEnv,
} from '@use-brian/core/engines/ask-engines.js'
import type {
  ExternalCredentialPool,
  ExternalCredentialLease,
} from '@use-brian/agent-runtime/providers/credential-pool.js'

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
  credentialPool?: ExternalCredentialPool,
  managedProviders: ReadonlySet<string> = new Set(),
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

  const credentialByEngine = {
    openai: { provider: 'engines-openai', envKey: 'ENGINES_OPENAI_API_KEY' },
    gemini: { provider: 'engines-gemini', envKey: 'ENGINES_GEMINI_API_KEY' },
    perplexity: { provider: 'engines-perplexity', envKey: 'ENGINES_PERPLEXITY_API_KEY' },
    claude: { provider: 'engines-anthropic', envKey: 'ENGINES_ANTHROPIC_API_KEY' },
  } as const
  const rosterEnv: EnginesEnv = credentialPool
    ? Object.fromEntries(
        Object.entries(env).concat(
          Object.values(credentialByEngine)
            .filter(({ provider, envKey }) => managedProviders.has(provider) && !env[envKey])
            .map(({ envKey }) => [envKey, '__managed__']),
        ),
      ) as EnginesEnv
    : env

  for (const asker of createEngineAskers(rosterEnv, fetchImpl)) {
    tools.push({
      name: asker.name,
      description: asker.description,
      inputSchema: { ...ASK_INPUT_SHAPE },
      handler: async (args) => {
        try {
          let activeAsker = asker
          let lease: ExternalCredentialLease | null = null
          if (credentialPool) {
            const credential = credentialByEngine[asker.engine]
            lease = await credentialPool.resolve(
              credential.provider,
              env[credential.envKey],
            )
            if (!lease) {
              return text(
                `${asker.name} failed: no eligible ${asker.engine} engine credential is configured`,
                true,
              )
            }
            activeAsker = createEngineAskers(
              { ...env, [credential.envKey]: lease.secret },
              fetchImpl,
            ).find((candidate) => candidate.name === asker.name)!
          }
          const run = await activeAsker.run(args as AskArgs, takeCallBudget)
          if (lease && run.successfulUnits > 0) {
            const costUsd = flatEngineCostUsd(asker.engine) * run.successfulUnits
            await lease.recordSpend(costUsd).catch((error) => {
              console.error(
                `[provider-credentials] failed to record ${asker.engine} engine MCP spend`,
                error instanceof Error ? error.message : String(error),
              )
            })
          }
          return text(JSON.stringify(run.payload, null, 2), run.allFailed)
        } catch (err) {
          return toolError(asker.name, err)
        }
      },
    })
  }

  return tools
}
