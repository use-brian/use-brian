/**
 * CLI entrypoint for research engine comparison (features/research.md ->
 * "Eval CLI"). Offline by default; the configured-provider adapter is built
 * only after `--collect --confirm`.
 */
import { calculateCost, createBaseTools, createGeminiProvider, NOOP_TURN_LEDGER, queryLoop } from '@use-brian/core'
import { createConfiguredProviderCollectionAdapter } from '../src/evals/research/collect.js'
import { runResearchEvalCli } from '../src/evals/research/cli.js'

void runResearchEvalCli(process.argv.slice(2), { log: console.log, error: console.error }, {
  configuredAdapter: async () => {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured; collection needs the configured provider.')
    const model = process.env.RESEARCH_EVAL_MODEL ?? 'gemini-flash'
    const tools = createBaseTools()
    const provider = createGeminiProvider(apiKey)
    return createConfiguredProviderCollectionAdapter({
      // The offline eval lane: no session turn, so no turn ledger.
      run: async ({ caseId, systemPrompt, prompt, tools, maxTurns, onEvent }) => {
        let usage = null
        for await (const event of queryLoop({
          ledger: NOOP_TURN_LEDGER, provider, model, systemPrompt, messages: [{ role: 'user', content: prompt }], tools, maxTurns,
          context: { userId: 'eval-user', assistantId: 'eval-assistant', sessionId: `eval-${caseId}`, appId: 'eval', channelType: 'web', channelId: 'eval', abortSignal: new AbortController().signal },
        })) {
          onEvent(event)
          if (event.type === 'turn_complete') usage = event.totalUsage ?? null
        }
        return { usage }
      },
      model,
      tools: new Map([...tools].filter(([, tool]) => tool.isReadOnly)),
      engine: { id: 'research-query-loop', version: process.env.RESEARCH_EVAL_ENGINE_VERSION ?? 'local' },
      costOf: (served, usage) => calculateCost(served, usage),
    })
  },
}).then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  },
)
