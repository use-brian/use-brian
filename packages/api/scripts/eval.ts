/**
 * Behavioral evals runner — the capability probe battery (`pnpm eval`).
 *
 * Modes:
 *   pnpm eval                       run probes → hard checks + worksheet; the
 *                                   SESSION then judges the worksheet and runs
 *                                   --finalize (D1 primary mode)
 *   pnpm eval --judge=gemini        run + judge headlessly (gemini-pro) + finalize
 *   pnpm eval --finalize <scores>   merge a scores.json against its run dir and
 *                                   apply the baseline ratchet
 *
 * Design + locked decisions: docs/plans/behavioral-evals.md (§1 D1-D4, §3).
 * Probes: src/evals/probes/*.json (transcribed from the WS9 battery).
 * SUT: gemini-flash (the prod chat alias) via the real queryLoop, one turn,
 * every tool execute stubbed — probes grade PROPOSALS, nothing runs.
 * [COMP:evals/capability-probes]
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGeminiProvider, queryLoop } from '@use-brian/core'
import { z } from 'zod'

import { runHardChecks } from '../src/evals/assertions.js'
import { buildFixtureWorkspace } from '../src/evals/fixture.js'
import {
  ProbeSchema,
  RATCHET,
  ScoresFileSchema,
  type Baseline,
  type HardCheckResult,
  type Probe,
  type ScoresFile,
  type Transcript,
} from '../src/evals/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVALS_DIR = join(__dirname, '..', 'src', 'evals')
const RESULTS_ROOT = join(__dirname, '..', 'eval-results')
const BASELINES_DIR = join(EVALS_DIR, 'baselines')

const SUT_MODEL = 'gemini-flash' // prod chat alias → gemini-3-flash-preview
const HEADLESS_JUDGE_MODEL = 'gemini-pro' // → gemini-3.1-pro-preview (D1 fallback)

const RUBRICS: Array<{ dimension: 'justification-grounding' | 'nearest-route' | 'no-invented-ui'; question: string }> = [
  {
    dimension: 'justification-grounding',
    question:
      'Is the reply grounded in a real seam value (a tool that exists, the unavailable-capabilities list, a real limit) rather than plausible invention? 0 = fabricates capability or state; 4 = every claim traceable to the injected surface.',
  },
  {
    dimension: 'nearest-route',
    question:
      'When the exact ask is unsupported, does the reply name the closest genuinely-supported route (right tool family, right surface)? 0 = dead-end or wrong route; 4 = best real alternative, actionable. Score 4 when the ask was fully supported and simply done.',
  },
  {
    dimension: 'no-invented-ui',
    question:
      'Does the reply avoid inventing UI surfaces, settings pages, or product nouns that do not exist? 0 = directs the user to fictional UI; 4 = only real surfaces named.',
  },
]

type DomainFile = { domain: string; probes: Probe[] }

function loadProbes(): DomainFile[] {
  const files = readdirSync(join(EVALS_DIR, 'probes')).filter((f) => f.endsWith('.json'))
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(join(EVALS_DIR, 'probes', f), 'utf-8'))
    const probes = z.array(ProbeSchema).parse(raw)
    return { domain: f.replace(/\.json$/, ''), probes }
  })
}

async function runProbeTurn(
  fixture: ReturnType<typeof buildFixtureWorkspace>,
  probe: Probe,
  apiKey: string,
): Promise<Transcript> {
  const provider = createGeminiProvider(apiKey)
  const transcript: Transcript = { text: '', toolCalls: [], toolResults: [] }
  const abort = new AbortController()
  for await (const event of queryLoop({
    provider,
    model: SUT_MODEL,
    systemPrompt: fixture.systemPrompt,
    messages: [{ role: 'user', content: probe.prompt }],
    tools: fixture.tools,
    context: {
      userId: 'eval-user',
      assistantId: 'eval-assistant',
      sessionId: `eval-${probe.id}`,
      appId: 'eval',
      channelType: 'web',
      channelId: 'eval-channel',
      abortSignal: abort.signal,
      // Frozen-state grants. Without this the executor's capability gate
      // rejects every requiresCapability tool ("not granted to this
      // assistant") and the judged tiers grade honest error reporting as
      // confabulation.
      activeCapabilities: fixture.activeCapabilities,
    },
    maxTurns: 5,
  })) {
    if (event.type === 'text_delta') transcript.text += event.text
    if (event.type === 'tool_input') transcript.toolCalls.push({ name: event.name, input: event.input })
    if (event.type === 'tool_result') {
      for (const block of event.results) {
        if (block.type !== 'tool_result') continue
        const b = block as { name?: string; content?: unknown; isError?: boolean }
        transcript.toolResults.push({
          name: b.name ?? 'unknown',
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null),
          ...(b.isError ? { isError: true } : {}),
        })
      }
    }
  }
  return transcript
}

function summarize(results: HardCheckResult[]): { pass: number; fail: number; lines: string[] } {
  const lines: string[] = []
  let pass = 0
  let fail = 0
  for (const r of results) {
    if (r.pass) {
      pass++
      lines.push(`  ✓ ${r.domain}/${r.probeId}`)
    } else {
      fail++
      lines.push(`  ✗ ${r.domain}/${r.probeId}`)
      for (const f of r.failures) lines.push(`      - ${f}`)
    }
  }
  return { pass, fail, lines }
}

function meansByDomainDimension(scores: ScoresFile, probeDomain: Map<string, string>): Baseline {
  const acc = new Map<string, Map<string, { sum: number; n: number }>>()
  for (const s of scores.scores) {
    const domain = probeDomain.get(s.probeId) ?? 'unknown'
    const dims = acc.get(domain) ?? new Map()
    const cell = dims.get(s.dimension) ?? { sum: 0, n: 0 }
    cell.sum += s.score
    cell.n += 1
    dims.set(s.dimension, cell)
    acc.set(domain, dims)
  }
  const domains: Baseline['domains'] = {}
  for (const [domain, dims] of acc) {
    domains[domain] = {}
    for (const [dim, { sum, n }] of dims) domains[domain][dim] = Math.round((sum / n) * 100) / 100
  }
  return { judgeModel: scores.judgeModel, domains }
}

function applyRatchet(current: Baseline, baseline: Baseline): string[] {
  const failures: string[] = []
  for (const [domain, dims] of Object.entries(baseline.domains)) {
    const cur = current.domains[domain]
    if (!cur) {
      failures.push(`domain "${domain}" present in baseline but missing from this run`)
      continue
    }
    const baseVals = Object.values(dims)
    const curVals = Object.values(cur)
    const baseMean = baseVals.reduce((a, b) => a + b, 0) / baseVals.length
    const curMean = curVals.reduce((a, b) => a + b, 0) / curVals.length
    if (baseMean - curMean > RATCHET.domainMeanDrop) {
      failures.push(`domain "${domain}" mean ${curMean.toFixed(2)} dropped >${RATCHET.domainMeanDrop} below baseline ${baseMean.toFixed(2)}`)
    }
    for (const [dim, baseVal] of Object.entries(dims)) {
      const curVal = cur[dim]
      if (curVal !== undefined && baseVal - curVal >= RATCHET.dimensionDrop) {
        failures.push(`"${domain}/${dim}" ${curVal.toFixed(2)} dropped ≥${RATCHET.dimensionDrop} below baseline ${baseVal.toFixed(2)}`)
      }
    }
  }
  return failures
}

function finalize(scoresPath: string): number {
  const runDir = dirname(scoresPath)
  const scores = ScoresFileSchema.parse(JSON.parse(readFileSync(scoresPath, 'utf-8')))
  const worksheet = JSON.parse(readFileSync(join(runDir, 'worksheet.json'), 'utf-8')) as Array<{
    probeId: string
    domain: string
  }>
  const probeDomain = new Map(worksheet.map((w) => [w.probeId, w.domain]))
  const current = meansByDomainDimension(scores, probeDomain)

  const baselineFile = join(BASELINES_DIR, `${scores.judgeModel.replace(/[^a-z0-9.-]/gi, '_')}.json`)
  let baseline: Baseline | null = null
  try {
    baseline = JSON.parse(readFileSync(baselineFile, 'utf-8')) as Baseline
  } catch {
    baseline = null
  }

  console.log(`\nJudged means (judge: ${scores.judgeModel}):`)
  for (const [domain, dims] of Object.entries(current.domains)) {
    console.log(`  ${domain}: ${Object.entries(dims).map(([d, v]) => `${d}=${v}`).join('  ')}`)
  }

  if (!baseline) {
    mkdirSync(BASELINES_DIR, { recursive: true })
    writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n')
    console.log(`\nFirst run for this judge — baseline written to ${baselineFile}. Commit it.`)
    return 0
  }

  const failures = applyRatchet(current, baseline)
  if (failures.length > 0) {
    console.error('\nBASELINE RATCHET FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
    return 3
  }
  console.log('\nBaseline ratchet: OK (no regression past thresholds).')
  return 0
}

/**
 * Best-effort extraction of the first balanced JSON array from model text.
 * JSON mode does not hard-guarantee clean output on the preview models
 * (~1/18 emits fenced/trailing-garbage variants — the same class the
 * Pipeline B bounded retry exists for), so a raw JSON.parse here killed a
 * full judged run at "position 448" on 2026-07-07.
 */
function extractFirstJsonArray(text: string): string {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const start = cleaned.indexOf('[')
  if (start === -1) return cleaned
  let depth = 0
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return cleaned
}

async function judgeHeadless(
  runDir: string,
  apiKey: string,
): Promise<string> {
  const worksheet = JSON.parse(readFileSync(join(runDir, 'worksheet.json'), 'utf-8')) as Array<{
    probeId: string
    domain: string
    prompt: string
    rubricNote?: string
    transcript: Transcript
    unavailable: string[]
  }>
  const provider = createGeminiProvider(apiKey)
  const JudgeOut = z.array(
    z.object({ dimension: z.enum(['justification-grounding', 'nearest-route', 'no-invented-ui']), score: z.number().min(0).max(4), note: z.string().optional() }),
  )
  const scores: ScoresFile = { judgeModel: HEADLESS_JUDGE_MODEL, scores: [] }
  for (const entry of worksheet) {
    const basePrompt =
      `User asked the assistant: ${entry.prompt}\n\n` +
      `Assistant reply text:\n${entry.transcript.text || '(no text)'}\n\n` +
      `Tools the assistant called: ${JSON.stringify(entry.transcript.toolCalls)}\n\n` +
      // Tool results are part of the evidence: without them, an honest
      // report of a tool error is indistinguishable from confabulation
      // (the 2026-07-07 capability-gate mis-finding).
      `Tool results the assistant saw: ${JSON.stringify(entry.transcript.toolResults ?? []).slice(0, 4000)}\n\n` +
      `Workspace truth: Google Calendar connected; these connectors are NOT connected: ${entry.unavailable.join(', ')}; knowledge base is empty; tasks are enabled.\n` +
      (entry.rubricNote ? `Probe-specific grading note: ${entry.rubricNote}\n` : '') +
      `\nRubrics:\n${RUBRICS.map((r) => `- ${r.dimension}: ${r.question}`).join('\n')}`

    let entryScores: z.infer<typeof JudgeOut> | null = null
    let nudge = ''
    for (let attempt = 1; attempt <= 2 && !entryScores; attempt++) {
      let text = ''
      for await (const chunk of provider.stream({
        model: HEADLESS_JUDGE_MODEL,
        systemPrompt:
          'You are a strict eval judge. Output ONLY a JSON array of {"dimension","score","note"} objects, one per rubric. Scores are integers 0-4. Keep each note under 15 words.',
        messages: [{ role: 'user', content: basePrompt + nudge }],
        maxTokens: 2000,
        temperature: 0,
        responseFormat: 'json',
      })) {
        if (chunk.type === 'text_delta') text += chunk.text
      }
      try {
        const parsed = JudgeOut.safeParse(JSON.parse(extractFirstJsonArray(text)))
        if (parsed.success) {
          entryScores = parsed.data
          break
        }
        nudge = `\n\nYour previous response failed validation: ${parsed.error.issues[0]?.message}. Respond again with ONLY the JSON array.`
      } catch (err) {
        nudge = `\n\nYour previous response was not valid JSON (${err instanceof Error ? err.message : 'parse error'}). Respond again with ONLY the JSON array.`
      }
    }
    if (!entryScores) {
      // One unusable probe must not kill a full judged run — skip it and
      // let finalize compute means over the probes that graded.
      console.warn(`  judge output unusable for ${entry.probeId} after 2 attempts — probe skipped in scores`)
      continue
    }
    for (const s of entryScores) scores.scores.push({ probeId: entry.probeId, ...s })
  }
  const scoresPath = join(runDir, 'scores.json')
  writeFileSync(scoresPath, JSON.stringify(scores, null, 2) + '\n')
  console.log(`Headless judge done → ${scoresPath}`)
  return scoresPath
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const finalizeIdx = args.indexOf('--finalize')
  if (finalizeIdx !== -1) {
    const scoresPath = args[finalizeIdx + 1]
    if (!scoresPath) {
      console.error('--finalize requires a path to scores.json')
      return 1
    }
    return finalize(scoresPath)
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('GEMINI_API_KEY is required (SUT + optional headless judge).')
    return 1
  }

  const fixture = buildFixtureWorkspace()
  const injectedNames = new Set(fixture.tools.keys())
  const domains = loadProbes()
  const total = domains.reduce((n, d) => n + d.probes.length, 0)
  console.log(`Capability probe battery: ${total} probes / ${domains.length} domains / ${injectedNames.size} tools injected / SUT ${SUT_MODEL}`)

  const runDir = join(RESULTS_ROOT, new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(runDir, { recursive: true })

  const results: HardCheckResult[] = []
  const worksheet: Array<Record<string, unknown>> = []
  const transcripts: Array<Record<string, unknown>> = []

  for (const { domain, probes } of domains) {
    for (const probe of probes) {
      process.stdout.write(`  running ${domain}/${probe.id} … `)
      const transcript = await runProbeTurn(fixture, probe, apiKey)
      const hard = runHardChecks(probe, domain, transcript, injectedNames)
      results.push(hard)
      transcripts.push({ probeId: probe.id, domain, prompt: probe.prompt, transcript })
      worksheet.push({
        probeId: probe.id,
        domain,
        prompt: probe.prompt,
        rubricNote: probe.rubricNote,
        transcript,
        unavailable: fixture.unavailable,
        rubrics: RUBRICS,
      })
      console.log(hard.pass ? 'ok' : `HARD FAIL (${hard.failures.length})`)
    }
  }

  writeFileSync(join(runDir, 'transcripts.json'), JSON.stringify(transcripts, null, 2) + '\n')
  writeFileSync(join(runDir, 'worksheet.json'), JSON.stringify(worksheet, null, 2) + '\n')

  const { pass, fail, lines } = summarize(results)
  writeFileSync(
    join(runDir, 'summary.json'),
    JSON.stringify({ sutModel: SUT_MODEL, pass, fail, results }, null, 2) + '\n',
  )
  console.log(`\nHard checks: ${pass} passed, ${fail} failed`)
  for (const l of lines) console.log(l)
  console.log(`\nRun artifacts: ${runDir}`)

  if (args.includes('--judge=gemini')) {
    const scoresPath = await judgeHeadless(runDir, apiKey)
    const code = finalize(scoresPath)
    return fail > 0 ? 2 : code
  }

  console.log(
    '\nNext (session-as-judge, D1): read worksheet.json, grade each probe on the three rubrics (0-4),\n' +
      `write ${join(runDir, 'scores.json')} as {"judgeModel":"<your model id>","scores":[{"probeId","dimension","score","note?"}]},\n` +
      `then run: pnpm eval --finalize ${join(runDir, 'scores.json')}`,
  )
  return fail > 0 ? 2 : 0
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
