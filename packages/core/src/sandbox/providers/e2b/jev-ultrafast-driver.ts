/**
 * Jev Ultrafast driver glue: deterministic Python for one watched browser
 * exploration plus the pure receipt mapper used by the host. The Python is
 * pinned to the reviewed upstream commit baked into the E2B image; this file
 * owns the narrower, version-tolerant boundary Brian consumes.
 */
import type { BrowserAgentUsage, BuTraceStep } from '../../types.js'

export const JEV_ULTRAFAST_DRIVER_PY = `"""Use Brian Jev Ultrafast driver.

Attach Browser Harness to the existing agent-browser Chromium, execute a
bounded goal, and always write a sanitized receipt. A pre-action failure
closes its owned target before fallback; a completed or partially executed run
leaves that target to the sandbox lifecycle so its final page stays visible.
Credentials stay in the process environment and never enter receipt.

The provider supplies agent-browser's WebSocket endpoint as BU_CDP_WS. Browser
Harness treats BU_CDP_URL as an HTTP discovery origin and would otherwise wait
30 seconds trying to fetch /json/version from a ws:// URL.
"""
import json
import os


def _read(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def _write(path, value):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)


def _usage(value):
    if not isinstance(value, dict):
        return {}
    return {
        key: value[key]
        for key in ("input_tokens", "output_tokens", "prompt_tokens", "completion_tokens")
        if isinstance(value.get(key), (int, float))
    }


def _receipt(agent, status, error):
    state = agent.state if agent is not None else {}
    page = state.get("page") if isinstance(state.get("page"), dict) else {}
    history = []
    for item in state.get("history", []):
        if not isinstance(item, dict):
            continue
        history.append({
            key: item.get(key)
            for key in ("step", "action", "kind", "text", "operation", "page_changed", "url")
        })
    decisions = []
    for item in state.get("decisions", []):
        if not isinstance(item, dict):
            continue
        decisions.append({
            "model": item.get("model"),
            "operation": item.get("operation"),
            "usage": _usage(item.get("usage")),
        })
    text_calls = []
    for item in state.get("text_calls", []):
        if not isinstance(item, dict):
            continue
        text_calls.append({
            "model": item.get("model"),
            "usage": _usage(item.get("usage")),
        })
    return {
        "schema_version": 1,
        "status": status,
        "start_url": os.environ.get("JEV_START_URL", ""),
        "final": {
            "url": page.get("url"),
            "title": page.get("title"),
            "text": str(page.get("text") or "")[:8000],
        },
        "history": history,
        "decisions": decisions,
        "text_calls": text_calls,
        "error": error,
    }


def _has_executed_action(agent):
    if agent is None or not isinstance(agent.state, dict):
        return False
    return any(
        isinstance(item, dict) and item.get("kind") not in {None, "wait"}
        for item in agent.state.get("history", [])
    )


def _configure_text_model_compat():
    """Adapt Jev's nested reasoning extension to provider wire dialects."""
    if os.environ.get("TEXT_MODEL_DIALECT") != "openai-chat-completions":
        return
    from jev_ultrafast import model as jev_model
    original_post_json = jev_model.post_json
    text_base = os.environ.get("TEXT_MODEL_BASE_URL", "").rstrip("/")

    def post_json_compat(url, key, body):
        if text_base and url.startswith(text_base + "/"):
            body = dict(body)
            body.pop("reasoning", None)
            body.pop("thinking", None)
            body["reasoning_effort"] = "low"
        return original_post_json(url, key, body)

    jev_model.post_json = post_json_compat


def _main():
    _configure_text_model_compat()
    from jev_ultrafast import Agent
    from browser_harness.helpers import cdp

    goal = _read(os.environ["JEV_GOAL_PATH"]).strip()
    start_url = os.environ["JEV_START_URL"]
    max_steps = max(1, min(int(os.environ.get("JEV_MAX_STEPS", "40")), 80))
    agent = None
    status = "error"
    error = None
    try:
        agent = Agent(start_url, goal, screenshots=False)
        # Jev intentionally creates a background target. Bring its owned tab
        # forward so the existing E2B screencast can follow the run.
        cdp("Target.activateTarget", targetId=agent.browser.target)
        for _ in range(max_steps):
            if agent.state.get("status") in {"done", "blocked"}:
                break
            agent.command("tick")
        status = agent.state.get("status", "error")
        if status not in {"done", "blocked"}:
            status = "max_steps"
            error = "Jev Ultrafast reached the configured action budget."
    except Exception as exc:
        status = "error"
        error = (type(exc).__name__ + ": " + str(exc))[-1000:]
    finally:
        _write(os.environ["JEV_RECEIPT_PATH"], _receipt(agent, status, error))
        # A clean DONE or any executed action keeps the final target alive for
        # evidence/live view. The sandbox owns Chromium and closes it at task
        # teardown. Close only a pre-action attempt so Browser Use can retry on
        # a clean target without leaving a blank Jev tab behind.
        if agent is not None and status != "done" and not _has_executed_action(agent):
            try:
                agent.close()
            except Exception:
                pass


_main()
`

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function tokensOf(value: unknown): { inputTokens: number; outputTokens: number } | null {
  const row = recordOf(value)
  if (!row) return null
  const input = row.input_tokens ?? row.prompt_tokens
  const output = row.output_tokens ?? row.completion_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return null
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null
  return { inputTokens: Math.round(input), outputTokens: Math.round(output) }
}

function compactVisibleText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 4_000)
}

export type JevUltrafastMappedReceipt = {
  trace: BuTraceStep[]
  output: string
  status: 'done' | 'blocked' | 'error' | 'max_steps'
  executedActions: number
  usage: Array<Omit<BrowserAgentUsage, 'providerKeySource'>>
  error?: string
}

/**
 * Convert the bounded Python receipt into Brian's replay trace and aggregate
 * token lines. Unknown fields and upstream schema drift degrade to a smaller
 * trace/receipt; they never throw through the provider seam.
 */
export function mapJevUltrafastReceipt(raw: unknown, fallbackStartUrl: string): JevUltrafastMappedReceipt {
  const root = recordOf(raw) ?? {}
  const final = recordOf(root.final) ?? {}
  const status = root.status === 'done' || root.status === 'blocked' || root.status === 'max_steps'
    ? root.status
    : 'error'
  const startUrl = stringOf(root.start_url) ?? fallbackStartUrl
  const finalUrl = stringOf(final.url) ?? startUrl
  const title = stringOf(final.title)
  const visibleText = compactVisibleText(final.text)
  const error = stringOf(root.error) ?? undefined
  const trace: BuTraceStep[] = [{ step: 1, action: 'open', url: startUrl }]
  let step = 1
  let executedActions = 0

  const history = Array.isArray(root.history) ? root.history : []
  for (const value of history) {
    const item = recordOf(value)
    if (!item) continue
    const kind = stringOf(item.kind)?.toLowerCase()
    if (!kind || kind === 'wait') continue
    executedActions += 1
    const url = stringOf(item.url) ?? finalUrl
    const label = stringOf(item.action)
    const text = stringOf(item.text)
    const operation = stringOf(item.operation)?.toUpperCase()
    step += 1
    if (kind === 'click') trace.push({ step, action: 'click', url, label })
    else if (kind === 'fill') trace.push({ step, action: 'fill', url, label, text: text ?? '' })
    else if (kind === 'scroll') {
      trace.push({
        step,
        action: 'scroll',
        url,
        detail: operation === 'SCROLL_UP' ? '-800' : '800',
      })
    } else {
      // Native select and future Jev operations are not replayable by the v0
      // logic-block runner. Count them for the no-replay safety boundary but
      // omit them from the draft rather than inventing a selector/action.
      step -= 1
    }
  }

  const evidence = [
    title ? `Final page: ${title}` : 'Final page',
    finalUrl ? `URL: ${finalUrl}` : '',
    visibleText ? `Visible page evidence: ${visibleText}` : '',
  ].filter(Boolean).join('\n')
  const output = status === 'done'
    ? evidence
    : `Jev Ultrafast stopped after ${executedActions} executed action${executedActions === 1 ? '' : 's'} (${status}).${error ? ` ${error}` : ''}${evidence ? `\n${evidence}` : ''}`
  if (status === 'done') {
    step += 1
    trace.push({ step, action: 'done', url: finalUrl, text: output.slice(0, 500) })
  }

  const usageByKey = new Map<string, Omit<BrowserAgentUsage, 'providerKeySource'>>()
  const addUsage = (kind: BrowserAgentUsage['kind'], value: unknown) => {
    const item = recordOf(value)
    const model = stringOf(item?.model)
    const tokens = tokensOf(item?.usage)
    if (!model || !tokens) return
    const key = `${kind}:${model}`
    const previous = usageByKey.get(key)
    usageByKey.set(key, {
      kind,
      model,
      inputTokens: (previous?.inputTokens ?? 0) + tokens.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + tokens.outputTokens,
    })
  }
  for (const decision of Array.isArray(root.decisions) ? root.decisions : []) addUsage('jev', decision)
  for (const textCall of Array.isArray(root.text_calls) ? root.text_calls : []) addUsage('text_helper', textCall)

  return { trace, output, status, executedActions, usage: [...usageByKey.values()], ...(error ? { error } : {}) }
}
