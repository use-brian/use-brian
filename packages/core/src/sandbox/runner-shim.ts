/**
 * The governed-runner shim (R2-9): the `runner` Python module we materialize
 * NEXT TO a logic-block inside the sandbox. Block code never shells out to
 * the raw agent-browser CLI — it drives these verbs:
 *
 *  - Non-terminal verbs (`open` / `snapshot` / `find` / `click` / `fill` /
 *    `eval` / `scroll` / `wait` / `current_url` / `log`) run free: they are
 *    deterministic glue over the agent-browser CLI inside the sandbox (the
 *    same CLI the provider itself uses — the 1984 pattern).
 *  - The ONE terminal verb, `runner.submit(ref, description)`, never fires
 *    on its own. It writes `.runner/send-<n>.request.json` and BLOCKS until
 *    the HOST-side gate answers with `.runner/send-<n>.decision.json`:
 *    grant-satisfied → approved (audit row written host-side), rehearsal →
 *    stubbed ("would send", never fires), otherwise → an async
 *    `pending_approvals` row and the block waits for the human.
 *    A ref that no longer resolves reports `drift`, which voids any grant
 *    host-side (R2-2) before the gate decides.
 *
 * The host half of the handshake lives in skill-runner.ts; this file is the
 * codegen + the file-protocol types shared by both halves and the tests.
 */

export const RUNNER_DIR = '.runner'
export const RUNNER_MODULE_PATH = 'runner.py'
export const BLOCK_MODULE_PATH = 'skill_block.py'
export const ENTRY_PATH = 'skill_main.py'
export const PARAMS_PATH = `${RUNNER_DIR}/params.json`
export const RESULT_PATH = `${RUNNER_DIR}/result.json`

export function sendRequestPath(n: number): string {
  return `${RUNNER_DIR}/send-${n}.request.json`
}
export function sendDecisionPath(n: number): string {
  return `${RUNNER_DIR}/send-${n}.decision.json`
}

/** What the shim writes when a block reaches a terminal send. */
export type BlockSendRequest = {
  n: number
  ref?: string | null
  /** Accessible label of the target, when the shim could resolve it. */
  label?: string | null
  /** The block's declared description of the send (the submit literal). */
  description?: string | null
  /** Set when the deterministic path broke (stale ref, missing element) — voids grants (R2-2). */
  drift?: string | null
}

/** What the host writes back. Exactly one of approved/stub decides the shim's behavior. */
export type BlockSendDecision = {
  approved: boolean
  /** Rehearsal (R2-5): record "would send", never fire. */
  stub?: boolean
  reason?: string
}

/** What the entry script writes when the block finishes. */
export type BlockRunResult = {
  ok: boolean
  summary?: string
  /** Rehearsal output: the sends that would have fired. */
  wouldSend?: Array<{ ref?: string | null; description?: string | null }>
  error?: string
}

/**
 * The `runner.py` source. Deliberately dependency-free Python 3: agent-browser
 * via subprocess (the shim IS the sanctioned wrapper — block code itself is
 * rejected by the effect contract if it touches subprocess), JSON files for
 * the send handshake.
 */
export function buildRunnerShimSource(opts: { sendTimeoutSeconds: number }): string {
  return `"""Use Brian governed browser runner (R2-9).

Blocks drive THESE verbs only. The terminal verb (submit) never fires without
a host-side gate decision: grant / approval / rehearsal-stub.
"""
import builtins
import json
import os
import subprocess
import time

RUNNER_DIR = ${JSON.stringify(RUNNER_DIR)}
SEND_TIMEOUT_SECONDS = ${Math.max(1, Math.floor(opts.sendTimeoutSeconds))}
_send_counter = 0
_would_send = []
_last_snapshot = {}


class RunnerDenied(Exception):
    """The gate denied (or timed out on) a terminal send."""


def _ab(*args):
    env = dict(os.environ)
    env.setdefault("AGENT_BROWSER_SESSION_NAME", os.environ.get("SKILL_SESSION_NAME", "skill"))
    proc = subprocess.run(
        ["agent-browser", *args], capture_output=True, text=True, timeout=40, env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "agent-browser failed").strip()[:500])
    return proc.stdout


def open(url):
    return _ab("open", url)


def snapshot():
    global _last_snapshot
    out = _ab("snapshot", "-i")
    _last_snapshot = {}
    for line in out.splitlines():
        parts = line.strip().lstrip("-* ").split(" ", 2)
        if len(parts) == 3 and parts[0].startswith("@e"):
            _last_snapshot[parts[0]] = parts[2].strip().strip('"')
    return out


def find(label):
    """Ref of the first snapshot node whose label contains the text (case-insensitive)."""
    needle = label.lower()
    for ref, name in _last_snapshot.items():
        if needle in name.lower():
            return ref
    return None


def click(ref):
    return _ab("click", ref)


def fill(ref, text):
    return _ab("fill", ref, text)


def eval(js):
    return _ab("eval", js)


def scroll(delta_y):
    return _ab("eval", "window.scrollBy(0, %d)" % int(delta_y))


def wait(seconds):
    time.sleep(min(float(seconds), 30.0))


def current_url():
    return _ab("get", "url").strip()


def log(message):
    print("[skill] %s" % message)


def would_send():
    return list(_would_send)


def submit(ref, description=None):
    """THE terminal verb: gate-checked host-side before the click fires."""
    global _send_counter
    _send_counter += 1
    n = _send_counter
    label = _last_snapshot.get(ref)
    drift = None
    if ref and ref not in _last_snapshot:
        drift = "unresolved ref %s (not in the latest snapshot)" % ref
    os.makedirs(RUNNER_DIR, exist_ok=True)
    with builtins.open(os.path.join(RUNNER_DIR, "send-%d.request.json" % n), "w") as f:
        json.dump({"n": n, "ref": ref, "label": label, "description": description, "drift": drift}, f)
    decision_path = os.path.join(RUNNER_DIR, "send-%d.decision.json" % n)
    deadline = time.time() + SEND_TIMEOUT_SECONDS
    while time.time() < deadline:
        if os.path.exists(decision_path):
            with builtins.open(decision_path) as f:
                decision = json.load(f)
            if decision.get("stub"):
                _would_send.append({"ref": ref, "description": description})
                return "stubbed"
            if decision.get("approved"):
                click(ref)
                return "sent"
            raise RunnerDenied(decision.get("reason") or "send denied")
        time.sleep(0.5)
    raise RunnerDenied("send approval timed out")
`
}

/**
 * The entry script: load params, run the block's `run(runner, params)`, and
 * persist a machine-readable result for the host.
 */
export function buildEntrySource(): string {
  return `import json
import traceback

import runner
import skill_block

result = {"ok": False}
try:
    with open(${JSON.stringify(PARAMS_PATH)}) as f:
        params = json.load(f)
    summary = skill_block.run(runner, params)
    result = {"ok": True, "summary": str(summary) if summary is not None else "", "wouldSend": runner.would_send()}
except runner.RunnerDenied as e:
    result = {"ok": False, "error": "denied: %s" % e, "wouldSend": runner.would_send()}
except Exception as e:  # noqa: BLE001 - the host needs the failure, whatever it is
    result = {"ok": False, "error": "%s\\n%s" % (e, traceback.format_exc()[:2000])}

import os
os.makedirs(${JSON.stringify(RUNNER_DIR)}, exist_ok=True)
with open(${JSON.stringify(RESULT_PATH)}, "w") as f:
    json.dump(result, f)
print(json.dumps(result))
`
}
