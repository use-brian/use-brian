/**
 * The popup's status wording (P1.7). Pure so it can be tested without a DOM.
 *
 * The popup used to render the RELAY SOCKET's state alone, which is only half
 * of "can the assistant act". A consent gate holding a Stop reports a healthy
 * socket, so the popup said "Connected" while every browse failed — the user
 * was told the product worked and watched it refuse. The gate's state outranks
 * the socket's here for exactly that reason.
 */

export type PopupStatus = {
  state?: string
  controlledTab?: number | null
  stopped?: boolean
  /**
   * Whether this install has the required `debugger` permission. Undefined from
   * an older background build and treated as present for upgrade compatibility.
   */
  hasControl?: boolean
  /** The relay's verdict on the build we reported. Undefined from a background that predates it. */
  staleBuild?: boolean
  /** This build's source fingerprint, for the popup's footer. Null on builds predating the stamp. */
  build?: string | null
}

const STATE_LABELS: Record<string, string> = {
  ready: 'Connected. The assistant can request browser tasks.',
  connecting: 'Connecting to the relay...',
  disconnected: 'Disconnected. Reconnecting automatically.',
  unpaired: 'Not paired. Paste a pairing token from Use Brian settings.',
  // Terminal by design: this pairing is live in another browser or profile,
  // and auto-reconnecting would evict that one and start a loop.
  replaced:
    'Another browser took over this pairing. Use Brian talks to that one now. Press Connect to take it back.',
}

const STOPPED_LABEL =
  'Task stopped. The next request will ask your permission again — no need to reload the extension.'

const NO_CONTROL_LABEL =
  'This extension is missing its required browser-control permission. Reload or reinstall it.'

const STALE_BUILD_LABEL =
  'This extension is out of date. Rebuild it and press Reload on chrome://extensions, then reconnect.'

/**
 * A separate line from `statusLine`, not a replacement for it.
 *
 * Staleness is a property of the install, not of what it is doing right now: a
 * stale extension still connects, still holds consent, still reports a tab.
 * Folding it into the one status line would mean choosing between telling the
 * user their socket is healthy and telling them their build is old, and both
 * are true. It ranks below the grant and Stop lines because those block work
 * outright, where staleness only might.
 */
export function buildWarning(status: PopupStatus): string | null {
  return status.staleBuild === true ? STALE_BUILD_LABEL : null
}

/** Footer text: which build is loaded. The question that took a SHA256 to answer. */
export function buildLine(status: PopupStatus): string {
  return status.build ? `Build ${status.build}` : 'Build unknown (predates build stamping)'
}

export function statusLine(status: PopupStatus): string {
  // A missing browser-control grant outranks everything, including a healthy
  // socket: the relay says "connected" while every task refuses, which is the
  // same lie the Stop case below exists to stop telling. `undefined` means an
  // older background that had the permission at install, so it is not a gap.
  if (status.hasControl === false) return NO_CONTROL_LABEL
  // A stopped gate wins over every socket state: nothing is being controlled,
  // so the tab note would be wrong as well as the "Connected" line.
  if (status.stopped) return STOPPED_LABEL
  const state = status.state ?? 'unpaired'
  const suffix = status.controlledTab != null ? ' Controlling one allowed tab.' : ''
  return `${STATE_LABELS[state] ?? state}${suffix}`
}
