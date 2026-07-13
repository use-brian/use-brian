/**
 * Effect-contract extractor (R2-5): the machine half of "the grant is the
 * review". A logic-block's contract is auto-extracted from its code by a
 * static scan — never hand-written — and shown to the human at grant time
 * next to the authoring recording. Two fail-closed rules:
 *
 *  1. Every terminal `runner.submit(...)` call site is surfaced as a
 *     terminal send verb (with its literal description when extractable).
 *  2. Any construct that could ACT outside the governed runner — a runner
 *     verb we don't know, subprocess/os.system, dynamic import/exec, raw
 *     socket/http modules, a literal agent-browser invocation — lands in
 *     `flagged`. A flagged block does not run (`runBrowserSkill` refuses):
 *     the runner materializes the shim, but static rejection is what keeps
 *     arbitrary code from shelling around the send-gate.
 *
 * Runtime safety still rides drift-voids-grant + the send-gate + the verb
 * ceiling (R2-5) — this scan is the authoring gate, not the last line.
 */

/** Verbs the governed runner exposes to block code (runner-shim.ts). */
export const RUNNER_VERBS: ReadonlySet<string> = new Set([
  'open',
  'snapshot',
  'find',
  'click',
  'fill',
  'eval',
  'scroll',
  'wait',
  'current_url',
  'log',
  'submit', // the ONLY terminal verb — routed through the send-gate
])

export type BrowserSkillContract = {
  site: string
  /** Param names the block accepts (from its params schema). */
  params: string[]
  /** Every `runner.submit` call site — the terminal send verbs. */
  terminalSends: Array<{ call: string; description: string | null }>
  /** Non-terminal runner verb usage counts (the reviewer's shape-of-the-block). */
  verbCounts: Record<string, number>
  /** Fail-closed findings — non-empty means the block is unrunnable as-is. */
  flagged: string[]
}

const DANGEROUS_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'subprocess', pattern: /\bsubprocess\b/ },
  { label: 'os.system', pattern: /\bos\s*\.\s*(system|popen|exec[a-z]*)\b/ },
  { label: 'exec()', pattern: /\bexec\s*\(/ },
  { label: 'eval()', pattern: /(?<!runner\s*\.\s*)\beval\s*\(/ },
  { label: '__import__', pattern: /__import__/ },
  { label: 'importlib', pattern: /\bimportlib\b/ },
  { label: 'socket', pattern: /\bimport\s+socket\b|\bfrom\s+socket\b/ },
  { label: 'http-client', pattern: /\b(?:import|from)\s+(urllib|requests|httpx|http\.client|aiohttp)\b/ },
  { label: 'agent-browser-cli', pattern: /agent-browser/ },
  { label: 'ctypes', pattern: /\bctypes\b/ },
  { label: 'open-write', pattern: /\bopen\s*\([^)]*['"][wa]b?['"]/ },
]

/**
 * The submit call's DESCRIPTION literal: the first string argument that is
 * neither a ref (`"@e6"`) nor swallowed by a nested `runner.find("…")` ref
 * lookup — `runner.submit(ref, description)`.
 */
function submitDescription(args: string): string | null {
  const withoutFind = args.replace(/runner\s*\.\s*find\s*\([^)]*\)/g, '')
  const LITERAL = /['"]((?:[^'"\\]|\\.)*)['"]/g
  let m: RegExpExecArray | null
  while ((m = LITERAL.exec(withoutFind)) !== null) {
    if (!/^@e\d+$/.test(m[1])) return m[1]
  }
  return null
}

export function extractEffectContract(params: {
  code: string
  site: string
  paramsSchema?: Record<string, unknown> | null
}): BrowserSkillContract {
  const { code, site } = params
  const flagged: string[] = []
  const verbCounts: Record<string, number> = {}
  const terminalSends: Array<{ call: string; description: string | null }> = []

  for (const { label, pattern } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) flagged.push(label)
  }

  // Every runner.<verb>(...) call site (args tolerate one nested call, e.g.
  // `runner.submit(runner.find("Send"), "…")`). An unknown verb fails closed.
  const CALL = /\brunner\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(((?:[^()]|\([^()]*\))*)/g
  let match: RegExpExecArray | null
  while ((match = CALL.exec(code)) !== null) {
    const [, verb, args] = match
    if (!RUNNER_VERBS.has(verb)) {
      flagged.push(`unknown-verb:${verb}`)
      continue
    }
    if (verb === 'submit') {
      terminalSends.push({
        call: match[0].slice(0, 200),
        description: submitDescription(args),
      })
    } else {
      verbCounts[verb] = (verbCounts[verb] ?? 0) + 1
    }
  }

  const schemaProps =
    params.paramsSchema && typeof params.paramsSchema === 'object'
      ? ((params.paramsSchema as { properties?: Record<string, unknown> }).properties ?? params.paramsSchema)
      : {}
  const paramNames = Object.keys(schemaProps as Record<string, unknown>).filter(
    (k) => !['type', 'properties', 'required', 'additionalProperties'].includes(k),
  )

  return {
    site,
    params: paramNames,
    terminalSends,
    verbCounts,
    flagged: [...new Set(flagged)],
  }
}

/** True when a stored contract says the block is safe to hand to the runner. */
export function contractAllowsRun(contract: Pick<BrowserSkillContract, 'flagged'>): boolean {
  return contract.flagged.length === 0
}

/** True when the block has no terminal sends — the read-only, zero-human case (R2-5). */
export function contractIsReadOnly(contract: Pick<BrowserSkillContract, 'terminalSends'>): boolean {
  return contract.terminalSends.length === 0
}
