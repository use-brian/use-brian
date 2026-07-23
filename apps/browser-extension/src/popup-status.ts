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

export function statusLine(status: PopupStatus): string {
  // A stopped gate wins over every socket state: nothing is being controlled,
  // so the tab note would be wrong as well as the "Connected" line.
  if (status.stopped) return STOPPED_LABEL
  const state = status.state ?? 'unpaired'
  const suffix = status.controlledTab != null ? ' Controlling one allowed tab.' : ''
  return `${STATE_LABELS[state] ?? state}${suffix}`
}
