/**
 * agent-browser CLI glue (§4.11): the deterministic strings the E2B provider
 * runs INSIDE the sandbox, and the parser for what comes back. Provider-
 * internal — the model never sees or emits these; it only calls the discrete
 * browser tools. Keeping every verb here means a CLI change is a one-file
 * template-version bump.
 *
 * Verb vocabulary matches the agent-browser CLI (`open`, `snapshot -i`,
 * `click @eN`, `fill @eN <text>`, `get url`, `get title`, `screenshot`,
 * `press`, `state save`, `close`); the daemon auto-starts on first use.
 * Session persistence is explicit, not name-keyed: the provider injects
 * auth state via AGENT_BROWSER_STATE=<file> (loaded at daemon launch —
 * the file MUST exist or launch fails) and captures via `state save <file>`
 * (Playwright storageState shape: {cookies, origins}).
 */
import type { BrowserSnapshot, BrowserSnapshotNode } from '../../types.js'
import { encodeActionCursorArmScript, type ActionCursorKind } from '../../action-cursor.js'

const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'textfield', 'textfieldwithcombobox', 'searchbox',
  'combobox', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'switch', 'slider', 'spinbutton', 'option', 'listboxoption', 'popupbutton',
])
const SNAPSHOT_ROLES = new Set([
  ...ACTIONABLE_ROLES,
  'caption', 'cell', 'columnheader', 'definition', 'heading', 'labeltext', 'legend',
  'listitem', 'paragraph', 'row', 'rowheader', 'statictext', 'table', 'term', 'text',
])

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const AGENT_BROWSER_BIN = 'agent-browser'

/**
 * The ONE agent-browser session name every sandbox uses. A sandbox is
 * task-scoped and single-tenant, so a per-sandbox name buys nothing; a fixed
 * name lets every browser command reconnect to the daemon lazily started by
 * the first command in that sandbox. The template itself starts no browser.
 */
export const SANDBOX_SESSION_NAME = 'main'

/**
 * The sandbox browser's viewport (CSS px, DPR 1). The agent-browser default
 * (1280×577) letterboxed the Take-Over view into a short wide band and made
 * lazy-loading sites reveal less per screen; 1440×900 matches a typical
 * laptop viewing window. Applied per-navigate (`set viewport` chains into the
 * same exec, so it costs no extra round trip) because both the lazy first
 * launch and a vault-injected relaunch start at the default.
 * The Take-Over wire cost does NOT scale with this: the stream bridge caps
 * frame pixels independently (takeover-stream.ts SCREENCAST maxWidth).
 */
export const SANDBOX_VIEWPORT = { width: 1440, height: 900 }

/** One agent-browser session per sandbox — the task's browsing identity. */
export function sessionEnv(sessionName: string): Record<string, string> {
  return { AGENT_BROWSER_SESSION_NAME: sessionName }
}

/**
 * Chain several verbs into ONE sandbox exec — every E2B command is a network
 * round trip, so navigate used to cost 2 and snapshot 3. Parts split on a
 * sentinel echoed between commands; `&&` keeps the fail-fast exit code, so a
 * failed verb still surfaces stderr through the caller's error mapping.
 */
export const PART_SEPARATOR = '__AB_PART__'

export function chainCommands(...cmds: string[]): string {
  return cmds.join(` && echo ${PART_SEPARATOR} && `)
}

export function splitCommandParts(stdout: string): string[] {
  return stdout.split(new RegExp(`\\n?${PART_SEPARATOR}\\n?`))
}

export const cli = {
  open(url: string): string {
    return `${AGENT_BROWSER_BIN} open ${shellQuote(url)}`
  },
  setViewport(width: number, height: number): string {
    return `${AGENT_BROWSER_BIN} set viewport ${Math.round(width)} ${Math.round(height)}`
  },
  snapshot(mode: 'interactive' | 'full' = 'interactive'): string {
    // -i = interactive elements with @e refs; no flag = full ariaSnapshot.
    return `${AGENT_BROWSER_BIN} snapshot${mode === 'interactive' ? ' -i' : ''}`
  },
  click(ref: string): string {
    return `${AGENT_BROWSER_BIN} click ${shellQuote(ref)}`
  },
  fill(ref: string, text: string): string {
    return `${AGENT_BROWSER_BIN} fill ${shellQuote(ref)} ${shellQuote(text)}`
  },
  /**
   * Cosmetic only: a failed page injection must never stop the real action
   * chained after it. `-b` keeps the generated page expression shell-safe.
   */
  armActionCursor(kind: ActionCursorKind): string {
    const encoded = encodeActionCursorArmScript(kind)
    return `(${AGENT_BROWSER_BIN} eval -b ${shellQuote(encoded)} >/dev/null 2>&1 || true)`
  },
  /**
   * Trusted auth-broker fill: the command string contains no credential.
   * The E2B adapter supplies `BRIAN_BROWSER_AUTH_SECRET` only on this one
   * process invocation; the shell expands it as one quoted argument.
   */
  fillFromSecretEnv(ref: string): string {
    return `${AGENT_BROWSER_BIN} fill ${shellQuote(ref)} "$BRIAN_BROWSER_AUTH_SECRET"`
  },
  getUrl(): string {
    return `${AGENT_BROWSER_BIN} get url`
  },
  getTitle(): string {
    return `${AGENT_BROWSER_BIN} get title`
  },
  screenshot(path: string): string {
    return `${AGENT_BROWSER_BIN} screenshot ${shellQuote(path)}`
  },
  press(key: string): string {
    return `${AGENT_BROWSER_BIN} press ${shellQuote(key)}`
  },
  /**
   * The daemon's Chromium CDP endpoint — the Take-Over input relay dispatches
   * trusted events through it (takeover-input.ts), and browser-use attaches
   * to it (bu-fallback). Validated in-sandbox 2026-07-13.
   */
  getCdpUrl(): string {
    return `${AGENT_BROWSER_BIN} get cdp-url`
  },
  /** Dump cookies + web storage (Playwright storageState JSON) to a file. */
  stateSave(path: string): string {
    return `${AGENT_BROWSER_BIN} state save ${shellQuote(path)}`
  },
  close(): string {
    return `${AGENT_BROWSER_BIN} close`
  },
}

/**
 * Parse `snapshot -i` output into the shared BrowserSnapshot node shape.
 * Tolerates all three output styles:
 *   - JSON (`--json`-style object with a nodes/elements array)
 *   - ref-first text lines: `@e1 button "Send"` / `- @e2 link "Jane" [disabled]`
 *   - the ariaSnapshot YAML the shipping CLI emits (validated in-sandbox
 *     2026-07-13 against agent-browser + Chrome 150):
 *       `- heading "Example Domain" [level=1, ref=e1]` / `- link "Learn more" [ref=e2]`
 * Unknown lines are skipped — the parser must never throw on real pages.
 */
export function parseSnapshotOutput(
  raw: string,
  page: { url: string; title: string },
  mode: 'interactive' | 'full' = 'interactive',
): BrowserSnapshot {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : ((parsed as { nodes?: unknown[]; elements?: unknown[] }).nodes ??
           (parsed as { elements?: unknown[] }).elements ??
           [])
      const nodes: BrowserSnapshotNode[] = []
      for (const item of list) {
        const o = item as { ref?: unknown; role?: unknown; name?: unknown; label?: unknown; value?: unknown; disabled?: unknown }
        const role = typeof o.role === 'string' ? o.role : 'node'
        const candidateRef = typeof o.ref === 'string' && o.ref.length > 0 ? o.ref : undefined
        const ref = mode === 'full' && !ACTIONABLE_ROLES.has(role.toLowerCase()) ? undefined : candidateRef
        const name = typeof o.name === 'string' ? o.name : typeof o.label === 'string' ? o.label : ''
        if (!ref && !name) continue
        nodes.push({
          ...(ref ? { ref: ref.startsWith('@') ? ref : `@${ref}` } : {}),
          role,
          name,
          ...(typeof o.value === 'string' && o.value ? { value: o.value } : {}),
          ...(o.disabled === true ? { disabled: true } : {}),
        })
      }
      return { url: page.url, title: page.title, nodes }
    } catch {
      // fall through to line parsing
    }
  }

  const LINE = /^[-*\s]*(@e\d+)\s+([\w-]+)\s+"((?:[^"\\]|\\.)*)"(?:\s+value="((?:[^"\\]|\\.)*)")?(.*)$/
  // ariaSnapshot YAML: role first, optional quoted name, ref inside a
  // trailing [attr, attr] group — `- link "Learn more" [ref=e2]`.
  const ARIA_LINE = /^[-*\s]*([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s*:\s*(.+?))?(?:\s+\[([^\]]*)\])?\s*$/
  const nodes: BrowserSnapshotNode[] = []
  for (const line of trimmed.split('\n')) {
    const m = LINE.exec(line.trim())
    if (m) {
      const [, ref, role, name, value, tail] = m
      nodes.push({
        ref,
        role,
        name: name.replace(/\\"/g, '"'),
        ...(value ? { value: value.replace(/\\"/g, '"') } : {}),
        ...(/\[disabled\]/.test(tail ?? '') ? { disabled: true } : {}),
      })
      continue
    }
    const a = ARIA_LINE.exec(line.trim())
    if (!a) continue
    const [, role, quotedName, plainName, attrs = ''] = a
    if (!SNAPSHOT_ROLES.has(role.toLowerCase())) continue
    const candidateRef = /\bref=(e\d+)\b/.exec(attrs)
    const ref = mode === 'full' && !ACTIONABLE_ROLES.has(role.toLowerCase()) ? null : candidateRef
    const name = (quotedName ?? plainName ?? '').trim().replace(/\\"/g, '"')
    if (!ref && !name) continue
    nodes.push({
      ...(ref ? { ref: `@${ref[1]}` } : {}),
      role,
      name,
      ...(/\bdisabled\b/.test(attrs) ? { disabled: true } : {}),
    })
  }
  return { url: page.url, title: page.title, nodes }
}
