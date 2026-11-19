/**
 * Capability-notice copy for `unavailable[]` and call-time connector failures
 * (moved from `mcp/inject.ts` by M3 WP2). Every string here reaches the model
 * on every channel; the decline-copy repo check governs its wording.
 *
 * See docs/architecture/integrations/mcp.md → "Unavailable capabilities".
 */
import { NOT_CONNECTED_DISPLAY_NAME } from '../tool-names.js'

/**
 * `unavailable[]` copy for a connector that is NOT connected (or is disabled
 * for this assistant).
 *
 * These notices state a FACT and name the surface that fixes it. They must
 * never embed a quotable reply sentence: on 2026-07-21 the gdrive notice
 * carried the script `reply: "I'll need Drive access first. Type /connect
 * gdrive to authorize."`, and a model that had wrongly concluded Gmail was
 * unavailable re-instantiated that template for Gmail, telling the user to
 * run `/connect gmail` while `gmailSendMessage` sat injected and usable.
 * A fill-in-the-blank refusal script in Layer 1 gets filled in.
 *
 * Point at Studio > Connectors, not at `/connect`: this text is read on
 * every channel, and `/connect` only exists on Telegram.
 *
 * Spec: `docs/architecture/integrations/mcp.md` -> "Unavailable capabilities".
 */
/**
 * What each built-in offers, as its not-connected notice names it. The
 * catalog renders `<display name>: not connected for this assistant (<this>)`
 * once per turn; keep a row in lockstep with the provider's own notice.
 */
export const NOT_CONNECTED_CAPABILITIES: Readonly<Record<string, string>> = {
  gcal: 'calendar events and availability',
  gmail: 'sending and reading email',
  gdrive: 'creating or opening docs, slides, spreadsheets, and Excel files',
  github: 'repositories, issues, and pull requests',
  notion: 'searching and updating Notion pages and databases',
  fathom: 'meeting transcripts, summaries, and action items',
  shopify: 'store products, orders, customers, and inventory',
  wordpress: 'managed page text and images',
  gsc: 'search performance, URL index status, sitemaps',
  msgraph: 'reading and searching Teams channels, chats, and members',
  imap: "searching, reading, and sending from the user's own corporate mailbox",
}

export function notConnectedNotice(displayName: string, capabilities: string): string {
  return `${displayName}: not connected for this assistant (${capabilities})`
}

/**
 * The message a Google tool call sees when the grant it needs is missing at
 * call time (the connector was disconnected between injection and execution,
 * or the token was auto-revoked). It rides inside the tool's failure copy, so
 * it names the product, says the connector is not connected — not that the
 * argument was wrong — and gives the reconnect remedy. Formerly the internal
 * id (`gcal not connected`), which the model could not map to a product.
 */
export function googleNotConnectedForCall(connectorId: string): string {
  const display = NOT_CONNECTED_DISPLAY_NAME[connectorId] ?? `Google (${connectorId})`
  return `${display} is not connected for this assistant (no Google grant is stored for it), so the call could not be made. Nothing about the arguments is wrong and retrying will not help — ask the user to connect it (Studio → Connectors) and try again once they confirm.`
}

/**
 * `unavailable[]` copy for a connector that IS connected but whose stored
 * credentials no longer work. Distinct from {@link notConnectedNotice}: here
 * reconnecting genuinely is the remedy.
 */
export function expiredCredentialsNotice(displayName: string): string {
  return `${displayName}: reconnect required (credentials expired or revoked; Studio → Connectors)`
}
