/**
 * Desktop OAuth code exchange (per provider) — the server-side half of the
 * desktop connector connect (RFC 8252 loopback handoff).
 *
 * The desktop shell drives a loopback flow (mirroring desktop sign-in),
 * receives the provider's OAuth `code`, and posts it to
 * `POST /api/connectors/:provider/exchange-and-store` with its OWN bearer. The
 * exchange runs HERE, server-side: client secrets are read from the process env
 * (the same names the web callbacks use) and never transit the loopback URL.
 * Each exchanger returns the single secret to persist plus the connected email
 * + a default multi-account label. Spec: docs/plans/desktop-connector-oauth-return.md.
 *
 * SHARED BY BOTH EDITIONS. The `/api/connectors` lifecycle is a forked router
 * pair (open `packages/api/src/routes/connectors.ts` + closed
 * `packages/api-platform/src/routes/connectors.ts` — see CLAUDE.md →
 * connector-route-parity). The exchange logic lives ONCE here, the
 * `resolve-domain.ts` pattern; each router wires its own `exchange-and-store`
 * route around it with its edition's credential-store conventions.
 *
 * Fathom is intentionally absent: its store path (`fathomTokens` tuple) is not
 * wired in store-credentials, so its desktop path stays on the web-redirect
 * behaviour until that lands (plan §6a). Adding it later is one entry here.
 */

export type DesktopOAuthExchangeResult = { secret: string; email: string | null; defaultLabel?: string }
export type DesktopOAuthExchanger = (args: { code: string; redirectUri: string }) => Promise<DesktopOAuthExchangeResult>

async function exchangeGoogleCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<DesktopOAuthExchangeResult> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Google OAuth is not configured')
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  if (!tokenRes.ok) throw new Error(`Google token exchange failed (HTTP ${tokenRes.status})`)
  const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string }
  // Same guard as the web callback: without a refresh_token we can never re-mint
  // access — the user granted before without revoking. Surface it, don't store.
  if (!tokens.refresh_token) throw new Error('Google returned no refresh_token (revoke prior access, then reconnect)')
  let email: string | null = null
  if (tokens.access_token) {
    try {
      const ui = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } })
      if (ui.ok) email = ((await ui.json()) as { email?: string }).email ?? null
    } catch { /* email is best-effort */ }
  }
  return { secret: tokens.refresh_token, email, defaultLabel: email ?? undefined }
}

async function exchangeNotionCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<DesktopOAuthExchangeResult> {
  const clientId = process.env.NOTION_CLIENT_ID
  const clientSecret = process.env.NOTION_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Notion OAuth is not configured')
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${basic}` },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  })
  if (!tokenRes.ok) throw new Error(`Notion token exchange failed (HTTP ${tokenRes.status})`)
  const tokens = (await tokenRes.json()) as { access_token?: string; workspace_name?: string }
  if (!tokens.access_token) throw new Error('Notion returned no access_token')
  return { secret: tokens.access_token, email: null, defaultLabel: tokens.workspace_name }
}

/** Providers whose desktop connect is wired (plan §6a). */
export const DESKTOP_OAUTH_EXCHANGERS: Record<string, DesktopOAuthExchanger> = {
  gcal: exchangeGoogleCode,
  gmail: exchangeGoogleCode,
  gdrive: exchangeGoogleCode,
  notion: exchangeNotionCode,
}
