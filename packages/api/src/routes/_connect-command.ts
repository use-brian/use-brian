/**
 * Shared `/connect` command handler — wired by both `telegram.ts` (official
 * bot) and `telegram-byo.ts` (BYO bot). Renders a Mini App button that
 * hands the user off to the web Settings > Connectors page, where their
 * existing web session is the sole auth boundary for per-connector grants.
 *
 * See `docs/architecture/channels/telegram-mini-app.md` → "/connect
 * command" and `docs/architecture/integrations/mcp.md` → "Connecting from
 * Telegram".
 */

import { OFFICIAL_CONNECTORS } from '@use-brian/shared'
import type { OutgoingMessage } from '@use-brian/channels'

export type ConnectCommandResult = {
  /** Reply to send. Always non-null when `handled === true`. */
  message: OutgoingMessage | null
  /** True if the text matched a /connect variant and a reply was produced. */
  handled: boolean
}

/**
 * Connectors the user can authorize through `/connect`. Derived from the
 * shared OFFICIAL_CONNECTORS registry — stays in sync if new built-ins are
 * added.
 */
type ConnectableInfo = { id: string; name: string }

function listConnectable(): ConnectableInfo[] {
  return OFFICIAL_CONNECTORS
    .filter((c) => c.enabled)
    .map((c) => ({ id: c.id, name: c.name }))
}

function findConnector(id: string): ConnectableInfo | null {
  return listConnectable().find((c) => c.id === id) ?? null
}

function miniAppUrl(appUrl: string, connectorId: string, botUsername?: string): string {
  // `/tg-link` auto-logs the user in (initData-verified) and honours `?next=`
  // to hand them off to /studio/connectors?connect=<id>, which auto-starts
  // the OAuth / PAT flow on load. On BYO bots we also pass `?bot=<username>`
  // so the verifier looks up that bot's token instead of the official one —
  // initData is HMAC-signed by whichever bot launched the Mini App.
  const next = `/studio/connectors?connect=${encodeURIComponent(connectorId)}`
  const botParam = botUsername ? `&bot=${encodeURIComponent(botUsername)}` : ''
  return `${appUrl}/tg-link?next=${encodeURIComponent(next)}${botParam}`
}

function renderMenu(appUrl: string, botUsername?: string): OutgoingMessage {
  const connectors = listConnectable()
  return {
    text: 'Which service would you like to connect?',
    actions: connectors.map((c) => ({
      kind: 'web_app' as const,
      label: c.name,
      url: miniAppUrl(appUrl, c.id, botUsername),
    })),
  }
}

function renderSingle(appUrl: string, c: ConnectableInfo, botUsername?: string): OutgoingMessage {
  return {
    text: `Tap below to authorize ${c.name}. Your connection is account-wide — per-assistant permissions are managed in Settings.`,
    actions: [
      { kind: 'web_app', label: `Authorize ${c.name}`, url: miniAppUrl(appUrl, c.id, botUsername) },
    ],
  }
}

function renderHelp(): OutgoingMessage {
  const ids = listConnectable().map((c) => `• \`/connect ${c.id}\` — ${c.name}`).join('\n')
  return {
    text: `Usage:\n\n\`/connect\` — show buttons for every service\n\`/connect <id>\` — one-tap button for that service\n\nAvailable services:\n${ids}`,
    format: 'markdown',
  }
}

function renderUnknown(id: string): OutgoingMessage {
  const known = listConnectable().map((c) => c.id).join(', ')
  return { text: `Unknown connector "${id}". Try one of: ${known}.` }
}

function renderNotLinked(): OutgoingMessage {
  return { text: "You're not linked yet — tap /start first." }
}

function renderNoAppUrl(): OutgoingMessage {
  return { text: 'Connector setup is unavailable on this bot (APP_URL not configured). Please use the web UI directly.' }
}

function renderByoNotOwner(): OutgoingMessage {
  return {
    text:
      "Only this bot's owner can manage its connectors. " +
      'Connectors on BYO bots are account-wide for the owner — your own grants would have no effect here. ' +
      "If you'd like your own assistant with your own connectors, chat with Use Brian directly (@sidanclaw_bot).",
  }
}

export type HandleConnectParams = {
  text: string
  isLinked: boolean
  appUrl: string | undefined
  /** Only relevant on BYO. When true, the speaker is NOT the assistant's owner. */
  byoNonOwner?: boolean
  /**
   * BYO bot's @handle (no leading @). When set, Mini App buttons carry
   * `?bot=<username>` so `/api/telegram/mini-app/verify` uses this bot's
   * token to check the initData HMAC. Omit on the official bot.
   */
  botUsername?: string
}

/**
 * Returns `{ handled: false }` if the text isn't a /connect variant, so the
 * caller can fall through to the normal message pipeline.
 */
export function handleConnectCommand(params: HandleConnectParams): ConnectCommandResult {
  const text = params.text.trim()
  if (!/^\/connect(\b|$)/i.test(text)) return { message: null, handled: false }

  const rest = text.slice('/connect'.length).trim()

  if (params.byoNonOwner) return { message: renderByoNotOwner(), handled: true }
  if (!params.isLinked) return { message: renderNotLinked(), handled: true }
  if (!params.appUrl) return { message: renderNoAppUrl(), handled: true }

  if (rest === '' ) return { message: renderMenu(params.appUrl, params.botUsername), handled: true }
  if (/^(help|list|\?)$/i.test(rest)) return { message: renderHelp(), handled: true }

  const c = findConnector(rest.toLowerCase())
  if (!c) return { message: renderUnknown(rest), handled: true }
  return { message: renderSingle(params.appUrl, c, params.botUsername), handled: true }
}
