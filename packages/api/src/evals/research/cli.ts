/**
 * `pnpm --filter @use-brian/api eval:research` (features/research.md -> "Eval CLI").
 *
 *   --dry-run [--manifest <cases.json>] [--split target|heldout|regression]
 *       Lists the selected cases, their requirements and whether the cost is
 *       known. No model or network call; never a price it does not have.
 *   --compare <baseline.json> <candidate.json> [--manifest <cases.json>]
 *       Offline comparison of two traces on one manifest.
 *   --check-case <case.json>
 *       Refuses a case that is not publishable (real-looking addresses, links,
 *       phones or production ids); generic cases use fabricated data.
 *   --collect --out <trace.json> [--manifest ...] [--split ...] [--confirm] [--allow-live]
 *       Configured-provider collection. Prints the preflight and stops unless
 *       --confirm is given for that preflight. Paid; never part of the build.
 *
 * With no --manifest the bundled fabricated fixture manifest is used, so
 * `--compare fixtures/baseline.trace.json fixtures/candidate.trace.json` is
 * the documented fixture comparison.
 *
 * [COMP:evals/research-comparison]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  collectResearchTrace,
  compareResearchTraces,
  dryRunResearchCases,
  publishableCaseProblems,
  ResearchCollectionRefused,
  ResearchComparisonError,
  type ResearchCase,
} from './comparison.js'

export const DEFAULT_RESEARCH_MANIFEST = fileURLToPath(new URL('./fixtures/cases.json', import.meta.url))

type Io = { log: (s: string) => void; error: (s: string) => void }

function option(argv: string[], name: string): string | null {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1]! : null
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

export async function runResearchEvalCli(argv: string[] = process.argv.slice(2), io: Io = { log: console.log, error: console.error }, deps: {
  /** Builds the configured-provider adapter; only reached after --confirm. */
  configuredAdapter?: () => Promise<Parameters<typeof collectResearchTrace>[0]['adapter']>
} = {}): Promise<number> {
  const manifestPath = option(argv, '--manifest') ?? DEFAULT_RESEARCH_MANIFEST
  const split = option(argv, '--split') as ResearchCase['split'] | null
  try {
    if (argv.includes('--dry-run')) {
      const plan = dryRunResearchCases(await readJson(manifestPath), split ? { split } : {})
      io.log(JSON.stringify({ mode: 'dry-run', modelCalls: 0, networkCalls: 0, ...plan }, null, 2))
      return 0
    }
    if (argv.includes('--check-case')) {
      const path = option(argv, '--check-case')
      if (!path) { io.error('Usage: --check-case <case.json>'); return 2 }
      const problems = publishableCaseProblems(await readJson(path))
      io.log(JSON.stringify({ mode: 'check-case', publishable: problems.length === 0, problems }, null, 2))
      return problems.length === 0 ? 0 : 1
    }
    if (argv.includes('--compare')) {
      const i = argv.indexOf('--compare')
      const [baseline, candidate] = [argv[i + 1], argv[i + 2]]
      if (!baseline || !candidate) { io.error('Usage: --compare <baseline.json> <candidate.json> [--manifest <cases.json>]'); return 2 }
      const result = compareResearchTraces(await readJson(manifestPath), await readJson(baseline), await readJson(candidate))
      io.log(JSON.stringify({ mode: 'compare', verification: 'local_verified', modelCalls: 0, networkCalls: 0, ...result }, null, 2))
      return result.hardFailures.newInCandidate.length > 0 ? 1 : 0
    }
    if (argv.includes('--collect')) {
      const out = option(argv, '--out')
      if (!out) { io.error('Usage: --collect --out <trace.json> [--confirm]'); return 2 }
      const manifest = await readJson(manifestPath)
      const preflight = dryRunResearchCases(manifest, split ? { split } : {})
      io.log(JSON.stringify({ mode: 'collect-preflight', ...preflight }, null, 2))
      if (!argv.includes('--confirm')) {
        io.error(`Collection runs real research and spends ${preflight.costKnown ? `about ${preflight.estimatedCostUsd} USD` : 'an unknown amount'}. Re-run with --confirm to proceed.`)
        return 2
      }
      if (!deps.configuredAdapter) { io.error('No configured provider adapter is available in this environment.'); return 2 }
      const trace = await collectResearchTrace({
        manifest, adapter: await deps.configuredAdapter(), preflight, confirmed: true, allowLive: argv.includes('--allow-live'),
        onCase: (caseId, r) => io.log(`collected ${caseId}: ${r.status}`),
      })
      await writeFile(out, JSON.stringify(trace, null, 2))
      io.log(`wrote ${out}`)
      return 0
    }
    io.error('Usage: eval:research --dry-run | --compare <baseline> <candidate> | --collect --out <file> [--confirm]')
    return 2
  } catch (error) {
    if (error instanceof ResearchComparisonError || error instanceof ResearchCollectionRefused) { io.error(error.message); return 2 }
    if (error && typeof error === 'object' && 'issues' in error) { io.error(`Invalid input: ${JSON.stringify((error as { issues: unknown }).issues)}`); return 2 }
    throw error
  }
}
