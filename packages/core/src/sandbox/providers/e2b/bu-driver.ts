/**
 * browser-use driver glue (R2-1): the deterministic Python the E2B provider
 * materializes into the sandbox for ONE watched exploration, plus the pure
 * mapper that turns browser-use's saved run history into the `BuTraceStep[]`
 * the self-heal distiller compiles (self-heal.ts).
 *
 * Why a Python driver and not a CLI line: browser-use ≥0.13 has no one-shot
 * `browser-use run --task-file … --trace …` interface — the imagined CLI
 * argparse-rejected with exit 2 on every prod run (2026-07-21 incident,
 * zero skills ever distilled). The 0.13 surface is the Python API: build an
 * LLM, attach to a browser over CDP, `Agent(task…).run()`. The driver is
 * provider-authored deterministic glue (never model code — §4.13 holds:
 * browser-use's autonomy lives in navigation, and its runs land as traces
 * that distill into REVIEWED logic-blocks, not as an open code lane).
 *
 * The trace contract deliberately splits version-sensitivity across the
 * seam: the driver stays dumb (run, save history JSON verbatim, write the
 * final answer) and the host-side `mapBrowserUseHistory` — unit-testable,
 * shipped with the API — absorbs the history schema. A browser-use bump
 * that drifts the schema degrades to fewer mapped steps, never a crash.
 */
import type { BuTraceStep } from '../../types.js'

/**
 * Env contract between the provider and the driver (all set per-run on the
 * exec, never sandbox-global):
 *   BU_CDP_URL     CDP endpoint of the agent-browser Chromium (cli.getCdpUrl)
 *   BU_GOAL_PATH   file carrying the exploration task text
 *   BU_TRACE_PATH  where the driver saves the AgentHistoryList JSON
 *   BU_OUT_PATH    where the driver writes the agent's final answer text
 *   BU_MAX_STEPS   step budget for the agentic loop
 *   BU_MODEL       model id (threaded from boot — never hardcoded in-tree)
 *   plus exactly one of ANTHROPIC_API_KEY / GOOGLE_API_KEY / OPENAI_API_KEY,
 *   which selects the chat-model class.
 */
export const BU_DRIVER_PY = `"""Use Brian browser-use driver (R2-1): one watched exploration, attached
over CDP to the same Chromium agent-browser drives, history saved for the
host-side self-heal distiller. Provider-authored deterministic glue."""
import asyncio
import json
import os


def _read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def _write(path, text):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


def _make_llm(model):
    # The key present selects the provider; the model id always comes from
    # the host (BU_MODEL) - no model id lives in the sandbox tree.
    if os.environ.get('ANTHROPIC_API_KEY'):
        try:
            from browser_use import ChatAnthropic
        except ImportError:
            from browser_use.llm import ChatAnthropic
        return ChatAnthropic(model=model)
    if os.environ.get('GOOGLE_API_KEY'):
        try:
            from browser_use import ChatGoogle
        except ImportError:
            from browser_use.llm import ChatGoogle
        return ChatGoogle(model=model)
    if os.environ.get('OPENAI_API_KEY'):
        try:
            from browser_use import ChatOpenAI
        except ImportError:
            from browser_use.llm import ChatOpenAI
        return ChatOpenAI(model=model)
    raise RuntimeError('no LLM API key in the driver environment')


def _make_browser(cdp_url):
    from browser_use import Browser

    # keep_alive: the exploration ATTACHES to agent-browser's Chromium -
    # the agent must never tear the shared browser down on completion.
    try:
        return Browser(cdp_url=cdp_url, keep_alive=True)
    except TypeError:
        return Browser(cdp_url=cdp_url)


async def _main():
    from browser_use import Agent

    goal = _read(os.environ['BU_GOAL_PATH']).strip()
    trace_path = os.environ['BU_TRACE_PATH']
    out_path = os.environ['BU_OUT_PATH']
    max_steps = int(os.environ.get('BU_MAX_STEPS', '40'))
    llm = _make_llm(os.environ['BU_MODEL'])
    browser = _make_browser(os.environ['BU_CDP_URL'])

    try:
        agent = Agent(task=goal, llm=llm, browser=browser)
    except TypeError:
        agent = Agent(task=goal, llm=llm, browser_session=browser)
    history = await agent.run(max_steps=max_steps)

    # Save the run history VERBATIM - the host-side mapper owns the schema.
    try:
        history.save_to_file(trace_path)
    except Exception:
        _write(trace_path, json.dumps(history.model_dump(mode='json')))

    final = None
    try:
        final = history.final_result()
    except Exception:
        pass
    _write(out_path, final or '')


asyncio.run(_main())
`

/** One browser-use action entry: `{action_name: {…params}}` (nulls skipped). */
function actionEntry(action: unknown): [string, Record<string, unknown>] | null {
  if (!action || typeof action !== 'object') return null
  for (const [name, params] of Object.entries(action as Record<string, unknown>)) {
    if (params && typeof params === 'object') return [name, params as Record<string, unknown>]
  }
  return null
}

/**
 * A human-usable label for the element an action touched, from the
 * serialized DOMHistoryElement's attributes. Returns null when nothing
 * find()-able exists — the distiller then skips that step (an incomplete
 * draft re-gates and re-heals; a phantom step never does).
 */
function labelOf(el: unknown): string | null {
  if (!el || typeof el !== 'object') return null
  const attrs = (el as { attributes?: unknown }).attributes
  if (attrs && typeof attrs === 'object') {
    const a = attrs as Record<string, unknown>
    for (const key of ['aria-label', 'placeholder', 'title', 'name', 'alt', 'value']) {
      const v = a[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Map a saved browser-use `AgentHistoryList` JSON (either `{history: […]}`
 * or a bare item array) into the distiller's `BuTraceStep[]` + the run's
 * final answer. Tolerant of schema drift by construction: unknown actions
 * and unreadable items are skipped, never thrown on.
 */
export function mapBrowserUseHistory(raw: unknown): { trace: BuTraceStep[]; output: string } {
  const items = Array.isArray(raw)
    ? raw
    : ((raw as { history?: unknown[] })?.history ?? [])
  const trace: BuTraceStep[] = []
  let output = ''
  let step = 0

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as {
      state?: { url?: unknown; interacted_element?: unknown[] }
      result?: unknown[]
      model_output?: { action?: unknown[] }
    }
    const url = asString(o.state?.url)
    const elements = Array.isArray(o.state?.interacted_element) ? o.state.interacted_element : []
    const results = Array.isArray(o.result) ? o.result : []
    const actions = Array.isArray(o.model_output?.action) ? o.model_output.action : []

    actions.forEach((action, i) => {
      const entry = actionEntry(action)
      if (!entry) return
      const [name, params] = entry
      const label = labelOf(elements[i])
      const resultText = asString((results[i] as { extracted_content?: unknown } | undefined)?.extracted_content)
      step += 1

      if (name.includes('go_to_url') || name.includes('navigate') || name === 'open_tab') {
        const target = asString(params.url)
        if (target) trace.push({ step, action: 'open', url: target })
      } else if (name.includes('search') && asString(params.query)) {
        trace.push({
          step,
          action: 'open',
          url: `https://www.google.com/search?q=${encodeURIComponent(params.query as string)}`,
        })
      } else if (name.includes('click')) {
        trace.push({ step, action: 'click', url, label })
      } else if (name.includes('input') || name.includes('fill') || name === 'type') {
        trace.push({ step, action: 'fill', url, label, text: asString(params.text) ?? '' })
      } else if (name.includes('scroll')) {
        // Older BU: {amount: px}; newer: {down, num_pages}. Normalize to px.
        const amount =
          typeof params.amount === 'number'
            ? params.amount
            : Math.round((typeof params.num_pages === 'number' ? params.num_pages : 1) * 800)
        trace.push({ step, action: 'scroll', url, detail: String(Math.abs(amount) || 800) })
      } else if (name.includes('extract')) {
        trace.push({ step, action: 'extract', url, text: resultText ?? asString(params.query) })
      } else if (name === 'done') {
        const text = asString(params.text) ?? resultText
        trace.push({ step, action: 'done', text })
        if (text) output = text
      } else {
        // wait / go_back / switch_tab / send_keys / … — not replayable at
        // the distiller's altitude; skipping keeps the draft honest.
        step -= 1
      }
    })
  }

  return { trace, output }
}
