import { Router, type Response } from 'express'
import { createTokens, verifyRefreshToken } from '../auth/jwt.js'
import { requireAuth } from '../auth/middleware.js'
import { verifyTgLinkToken } from '../auth/tg-link-token.js'
import { isValidTimezone } from '../auth/client-timezone.js'
import { findOrCreateUser, findUserById, findUserByEmail, promoteChannelUser, updateUserTimezone, type User } from '../db/users.js'
import { query } from '../db/client.js'
import { mergeShadowUser, type LinkedAccountStore } from '../db/linked-accounts.js'
import type { ApiKeyStore } from '../db/api-key-store.js'
import type { ShadowClaimStore } from '../db/shadow-claim-store.js'
import type { MagicLinkConsumed, MagicLinkLocale, MagicLinkStore } from '../db/magic-link-store.js'
import type { DesktopAuthStore } from '../db/desktop-auth-store.js'
import type { SmtpClient } from '../email/smtp-client.js'
import { createHash } from 'node:crypto'

/**
 * Fire-and-forget hook invoked after a Telegram identity is successfully
 * bound to a user via the Mini App onramp. The apps/api wiring supplies
 * an implementation that sends a Telegram "you're linked" confirmation
 * so the mobile flow (which completes OAuth in the system browser and
 * leaves the user with no in-Telegram success signal) gets closure.
 */
export type NotifyTelegramLinked = (
  chatId: string,
  firstName: string | null,
) => Promise<void>

/**
 * Optional dependencies for the email magic-link sign-in path. Both must be
 * provided for the `/email/*` routes to be functional; if either is missing
 * the routes still mount but return 503, which the web layer surfaces as
 * "Email sign-in is temporarily unavailable" without breaking the page.
 *
 * See docs/architecture/platform/auth.md → "Email magic-link flow".
 */
export type EmailAuthDeps = {
  magicLinkStore?: MagicLinkStore
  smtpClient?: SmtpClient
  /** Used to build the verify URL embedded in the email — e.g. `https://sidan.ai`. */
  appUrl: string
}

/**
 * Auth routes:
 *   POST /auth/google              — Exchange Google OAuth token for JWT
 *   POST /auth/email/request-link  — Send a single-use magic-link email
 *                                    (see docs/architecture/platform/auth.md → "Email magic-link flow")
 *   POST /auth/email/verify        — Consume a magic-link token, mint JWT
 *   POST /auth/refresh             — Exchange refresh token for new access token
 *   POST /auth/claim/issue-token   — Mint a shadow-claim consent token
 *                                    (see docs/architecture/features/shadow-claim.md)
 */
export function authRoutes(
  jwtSecret: string,
  googleClientId?: string,
  linkedAccountStore?: LinkedAccountStore,
  notifyTelegramLinked?: NotifyTelegramLinked,
  shadowClaimStore?: ShadowClaimStore,
  apiKeyStore?: ApiKeyStore,
  emailAuth?: EmailAuthDeps,
  desktopAuthStore?: DesktopAuthStore,
): Router {
  const router = Router()

  /**
   * Google OAuth: client sends Google ID token, we verify and issue JWT.
   *
   * Optional `tgLinkToken` (see docs/architecture/channels/telegram-mini-app.md)
   * binds a Telegram identity to the resulting user in the same request:
   *   1. Client obtains tgLinkToken from POST /api/telegram/mini-app/verify
   *      after Telegram's initData is validated.
   *   2. Client passes it as `state` through Google OAuth, back to the
   *      web callback, which forwards it here alongside the idToken.
   *   3. We bind Telegram → user via linkedAccountStore.upsert + mergeShadowUser.
   */
  router.post('/google', async (req, res) => {
    const { idToken, tgLinkToken, timezone: bodyTimezone } = req.body as {
      idToken?: string
      tgLinkToken?: string
      timezone?: string
    }
    if (!idToken) {
      res.status(400).json({ error: 'Missing idToken' })
      return
    }

    // Capture the browser's IANA timezone at sign-up so telegram-only users
    // don't stay stuck at the 'UTC' default forever. Prefer the validated
    // `X-Client-Timezone` header (attachClientTimezone middleware has already
    // rejected malformed values); fall back to the request body field so the
    // OAuth callback path — which threads tz through the Google `state`
    // parameter — can still seed new accounts. Validate here too because
    // body values bypass the middleware's validator.
    const headerTz = req.clientTimezone
    const rawBodyTz = typeof bodyTimezone === 'string' ? bodyTimezone.trim() : ''
    const captureTz = headerTz
      ? headerTz
      : rawBodyTz && rawBodyTz.length > 0 && rawBodyTz.length < 80 && isValidTimezone(rawBodyTz)
        ? rawBodyTz
        : undefined

    try {
      // Verify Google ID token via Google's tokeninfo endpoint
      const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`)
      if (!googleRes.ok) {
        res.status(401).json({ error: 'Invalid Google token' })
        return
      }

      const googleData = await googleRes.json() as {
        sub: string
        email: string
        name?: string
        picture?: string
        aud: string
      }

      // Verify audience matches our client ID (if configured)
      if (googleClientId && googleData.aud !== googleClientId) {
        res.status(401).json({ error: 'Token audience mismatch' })
        return
      }

      // Check for existing shadow user with same email — promote instead of
      // creating a new account. See docs/architecture/channels/channel-user-identity.md.
      let user: User
      let isNew = false
      const existingShadow = await findUserByEmail(googleData.email)
      if (existingShadow && existingShadow.authProvider === 'channel') {
        await promoteChannelUser(existingShadow.id, {
          authProvider: 'google',
          authProviderId: googleData.sub,
          name: googleData.name,
          avatarUrl: googleData.picture,
        })
        // Backfill the promoted shadow user's timezone from the sign-up
        // signal when they were still on the column default. Channel-
        // originated shadows have `users.timezone = 'UTC'` because the
        // telegram/whatsapp webhook has no browser timezone to capture.
        if (
          captureTz &&
          (!existingShadow.timezone || existingShadow.timezone === 'UTC')
        ) {
          await updateUserTimezone(existingShadow.id, captureTz).catch((err) =>
            console.error('[auth/google] shadow promotion tz backfill failed:', err),
          )
          existingShadow.timezone = captureTz
        }
        user = { ...existingShadow, authProvider: 'google', authProviderId: googleData.sub }
      } else {
        const result = await findOrCreateUser({
          authProvider: 'google',
          authProviderId: googleData.sub,
          email: googleData.email,
          name: googleData.name,
          avatarUrl: googleData.picture,
          timezone: captureTz,
        })
        user = result.user
        isNew = result.isNew
      }

      // Optional: bind a Telegram identity to this user (Mini App onramp).
      let linkWarning: string | undefined
      if (tgLinkToken) {
        linkWarning = await tryLinkTelegram(
          user.id,
          tgLinkToken,
          jwtSecret,
          linkedAccountStore,
          notifyTelegramLinked,
        )
      }

      // Issue tokens
      const tokens = createTokens(user.id, jwtSecret)

      res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
        isNew,
        ...(linkWarning ? { linkWarning } : {}),
        ...tokens,
      })
    } catch (err) {
      console.error('Google auth error:', err)
      res.status(500).json({ error: 'Authentication failed' })
    }
  })

  // ── Email magic-link sign-in ───────────────────────────────────
  //
  // Two halves: request-link (mints a token, emails the user) and verify
  // (consumes the token, mints the JWT pair). The pair shares the same
  // JWT mint + refresh + cookie path as Google OAuth — only the entry
  // point differs. See docs/architecture/platform/auth.md → "Email
  // magic-link flow".

  /**
   * Mint a magic-link token and email it to the recipient.
   *
   * **Response is unconditionally 200.** Whether the request was
   * rate-limited, the email was malformed, or the mail was sent, the
   * shape and timing of the response are identical. This is what
   * prevents email enumeration — an attacker probing this endpoint can't
   * tell which addresses are accepted.
   *
   * Rate limits (DB-counted so they survive Cloud Run instance rotation):
   *   - 3 requests / email / rolling hour
   *   - 10 requests / IP / rolling hour
   *
   * The locale is captured from the `Accept-Language` request header (or
   * the body's `locale` field as fallback) and stored alongside the
   * token. The verify route reads it back when the user clicks the link
   * so the post-sign-in landing matches.
   */
  router.post('/email/request-link', async (req, res) => {
    if (!emailAuth || !emailAuth.magicLinkStore || !emailAuth.smtpClient) {
      console.warn('[auth/email] request-link hit but emailAuth not configured (GMAIL_SMTP_* envs missing)')
      res.status(503).json({ error: 'email_signin_unavailable' })
      return
    }
    const { magicLinkStore, smtpClient, appUrl } = emailAuth

    const body = req.body as {
      email?: unknown
      nextPath?: unknown
      locale?: unknown
      addAccount?: unknown
    }

    // Multi-account "add" intent, threaded from `/login?addAccount=1`. We
    // can't validate a session here (the request originates from the login
    // page, before the new account exists), so we carry it as a flag in the
    // verify link's query string. The web verify route honours it only when
    // a current session cookie is actually present, so a tampered flag can
    // at worst stash the clicker's *own* session — it leaks nothing. See
    // docs/architecture/platform/auth.md → "Multi-account switching".
    const addAccount = body.addAccount === true || body.addAccount === '1'

    // Validate inputs — but on any validation failure we still return
    // 200 with the same shape, so the response surface doesn't leak
    // whether the email was acceptable.
    const ok200 = () => res.status(200).json({ ok: true })

    const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!isValidEmail(emailRaw)) {
      // Constant-time-ish: still spend a tiny moment before responding.
      await new Promise((r) => setTimeout(r, 5))
      ok200()
      return
    }

    const nextPath =
      typeof body.nextPath === 'string' && isAllowedNextPath(body.nextPath)
        ? body.nextPath
        : undefined

    const locale: MagicLinkLocale = isMagicLinkLocale(body.locale)
      ? body.locale
      : pickLocaleFromHeader(req.headers['accept-language'])

    const ip = extractClientIp(req)
    const userAgent = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent']
      : undefined

    try {
      const now = new Date()
      const windowStart = new Date(now.getTime() - 60 * 60 * 1000)
      const [emailCount, ipCount] = await Promise.all([
        magicLinkStore.countRecentForEmail(emailRaw, windowStart),
        ip ? magicLinkStore.countRecentForIp(ip, windowStart) : Promise.resolve(0),
      ])
      if (emailCount >= 3 || ipCount >= 10) {
        console.warn(`[auth/email] rate-limited: email=${emailRaw} count=${emailCount} ip=${ip ?? 'none'} ipCount=${ipCount} — silently 200ing`)
        ok200()
        return
      }

      const { token, code } = await magicLinkStore.create({
        email: emailRaw,
        nextPath,
        locale,
        ip,
        userAgent,
      })

      // The verify URL is on the web app, not the API — Next.js renders a
      // **confirm page** at `/login/verify` (a bare GET that does NOT consume
      // the token, so email link-scanners / prefetchers can't burn it), and
      // the "Sign in" button POSTs to `/api/auth/email/verify` to consume it.
      // The API never receives the token directly from the user's browser;
      // only the web layer does. `addAccount=1` rides along so the confirm POST
      // stashes the current session instead of replacing it when the link is
      // opened in the same browser. `lang` carries the locale so the confirm
      // page renders correctly on a device with no locale cookie (cross-device
      // copy-paste). See docs/architecture/platform/auth.md → "Email
      // magic-link flow".
      const link =
        `${appUrl.replace(/\/$/, '')}/login/verify?token=${encodeURIComponent(token)}&lang=${locale}` +
        (addAccount ? '&addAccount=1' : '')

      // Fire-and-forget: we don't block the response on SMTP. If sending
      // fails, the user simply doesn't get the email — but the response
      // is still 200 to keep the timing shape stable. The `code` is the OTP
      // the user can type on any device instead of opening the link.
      smtpClient.sendMagicLink(emailRaw, link, locale, code)
        .catch((err) => {
          console.error('[auth/email] SMTP send failed:', err)
        })

      ok200()
    } catch (err) {
      console.error('[auth/email] request-link error:', err)
      // Still 200 — see docstring. The error is logged for ops.
      ok200()
    }
  })

  /**
   * Exchange a magic-link token for the standard JWT pair.
   *
   * Consume is atomic via `magicLinkStore.consumeByToken` — a parallel
   * second click on the same link will land on the `null` branch.
   *
   * If the email already maps to an existing user (any auth_provider),
   * the user is signed into that existing row. Only fresh emails create
   * a new user with `auth_provider='email'`. This lets a user who
   * originally signed up with Google later sign in via email magic link
   * without producing a duplicate account.
   */
  router.post('/email/verify', async (req, res) => {
    if (!emailAuth || !emailAuth.magicLinkStore) {
      res.status(503).json({ error: 'email_signin_unavailable' })
      return
    }
    const { magicLinkStore } = emailAuth

    const { token, timezone: bodyTimezone } = req.body as {
      token?: unknown
      timezone?: unknown
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }

    const consumed = await magicLinkStore.consumeByToken(token)
    if (!consumed) {
      res.status(401).json({ error: 'expired_or_used' })
      return
    }

    await respondWithEmailSession(
      res,
      jwtSecret,
      consumed,
      resolveCaptureTz(req.clientTimezone, bodyTimezone),
    )
  })

  /**
   * Exchange an emailed 6-digit passcode for the standard JWT pair — the OTP
   * sign-in path a user can complete on any device by typing the code, without
   * opening the link. Same account-resolution + JWT mint as `/email/verify`.
   *
   * Consume is atomic (`consumeByCode`); brute force of the code space is bounded
   * by the store's per-email attempt lockout (`locked` → 429) on top of
   * request-link's 3-codes/email/hour cap. A wrong / expired / unknown code is a
   * generic 401 `expired_or_used` — indistinguishable from a code for an email
   * that never requested one, so this endpoint doesn't leak which emails exist.
   * Unlike the link path there is no `addAccount` here: a code is typed on the
   * target device, which is the normal cross-device sign-in, never same-browser
   * account stashing. See docs/architecture/platform/auth.md → "Email
   * magic-link flow".
   */
  router.post('/email/verify-code', async (req, res) => {
    if (!emailAuth || !emailAuth.magicLinkStore) {
      res.status(503).json({ error: 'email_signin_unavailable' })
      return
    }
    const { magicLinkStore } = emailAuth

    const { email, code, timezone: bodyTimezone } = req.body as {
      email?: unknown
      code?: unknown
      timezone?: unknown
    }
    const emailRaw = typeof email === 'string' ? email.trim().toLowerCase() : ''
    const codeRaw = typeof code === 'string' ? code.trim() : ''
    if (!isValidEmail(emailRaw) || !/^\d{6}$/.test(codeRaw)) {
      res.status(400).json({ error: 'invalid_code' })
      return
    }

    const result = await magicLinkStore.consumeByCode(emailRaw, codeRaw)
    if (result.status === 'locked') {
      res.status(429).json({ error: 'too_many_attempts' })
      return
    }
    if (result.status !== 'ok') {
      res.status(401).json({ error: 'expired_or_used' })
      return
    }

    await respondWithEmailSession(
      res,
      jwtSecret,
      result,
      resolveCaptureTz(req.clientTimezone, bodyTimezone),
    )
  })

  /**
   * Read the authed user's current Telegram linked-assistant binding.
   * Consumed by the Mini App `/tg-link/manage` page to highlight the
   * currently-bound assistant. Returns `{ assistantId: null }` for a
   * user with no linked Telegram (e.g., they opened `/manage` without
   * ever running /start in the bot).
   */
  router.get('/telegram-link', requireAuth(jwtSecret), async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    // Post-Stage-6: user_linked_accounts dropped. Compose the legacy
    // shape from linked_identities + channel_routes.
    const result = await query<{ assistantId: string | null }>(
      `SELECT cr.assistant_id AS "assistantId"
       FROM linked_identities li
       LEFT JOIN channel_routes cr
         ON cr.provider = li.provider AND cr.provider_id = li.provider_id
       WHERE li.user_id = $1 AND li.provider = 'telegram'
       LIMIT 1`,
      [userId],
    )
    res.json({ assistantId: result.rows[0]?.assistantId ?? null })
  })

  /**
   * Update which assistant the authed user's linked Telegram routes to on the
   * official bot. Consumed by the Mini App `/tg-link/manage` page when a user
   * taps "switch to this assistant". See docs/architecture/channels/telegram-mini-app.md.
   *
   * Preconditions: the user must own the target assistant, and they must have
   * an existing `linked_accounts` row for `telegram` (i.e., they must have
   * done the initial link via Mini App or 6-char code). A missing link means
   * the user hit `/manage` without ever linking — 404 and direct them to /start.
   */
  router.post('/telegram-link-update', requireAuth(jwtSecret), async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (!linkedAccountStore) {
      res.status(503).json({ error: 'Telegram linking not configured' })
      return
    }

    const { assistantId } = req.body as { assistantId?: unknown }
    if (typeof assistantId !== 'string' || assistantId.length === 0) {
      res.status(400).json({ error: 'Missing assistantId' })
      return
    }

    const assistantRow = await query<{ id: string; name: string }>(
      `SELECT id, name FROM assistants WHERE id = $1 AND owner_user_id = $2`,
      [assistantId, userId],
    )
    if (assistantRow.rows.length === 0) {
      res.status(403).json({ error: 'Not the owner of that assistant' })
      return
    }

    // Post-Stage-6: read the identity half of the split. provider_metadata
    // → metadata in linked_identities.
    const existing = await query<{ provider_id: string; provider_metadata: Record<string, unknown> | null }>(
      `SELECT provider_id, metadata AS provider_metadata
       FROM linked_identities
       WHERE user_id = $1 AND provider = 'telegram'
       LIMIT 1`,
      [userId],
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'No linked Telegram account — run /start in the bot first.' })
      return
    }

    try {
      await linkedAccountStore.upsert({
        userId,
        assistantId,
        provider: 'telegram',
        providerId: existing.rows[0].provider_id,
        providerMetadata: existing.rows[0].provider_metadata ?? undefined,
      })
    } catch (err) {
      console.error('[auth] telegram-link-update failed:', err)
      res.status(500).json({ error: 'Failed to update Telegram link' })
      return
    }

    res.json({
      ok: true,
      assistant: { id: assistantRow.rows[0].id, name: assistantRow.rows[0].name },
    })
  })

  /**
   * Refresh: exchange refresh token for new access + refresh tokens.
   */
  router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body as { refreshToken?: string }
    if (!refreshToken) {
      res.status(400).json({ error: 'Missing refreshToken' })
      return
    }

    const userId = verifyRefreshToken(refreshToken, jwtSecret)
    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    const tokens = createTokens(userId, jwtSecret)

    // Return fresh user data so the frontend can update the stale `user` cookie.
    // Without this, the plan badge stays on "free" after a Stripe upgrade.
    const user = await findUserById(userId)

    res.json({
      ...tokens,
      ...(user && {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
        },
      }),
    })
  })

  // ── Desktop app sign-in (RFC 8252 + PKCE handoff) ──────────────
  //
  // The Electron shell completes Google OAuth in the system browser, then the
  // browser-side `/desktop/auth` bridge mints a single-use code here (for the
  // already-authenticated user) and 302s to `sidanclaw://auth?code=…`. The app
  // exchanges that code for the JWT pair over TLS. A PKCE verifier binds the
  // code to the app instance so a local app that hijacks the `sidanclaw://`
  // scheme can't redeem a stolen code (it lacks the verifier). RFC 8252 + 7636.
  // See docs/architecture/platform/auth.md → "Desktop app sign-in (PKCE handoff)".
  const B64URL_RE = /^[A-Za-z0-9_-]+$/

  /** Mint a single-use code for the authenticated user, bound to a PKCE challenge. */
  router.post('/desktop/code', requireAuth(jwtSecret), async (req, res) => {
    if (!desktopAuthStore) {
      res.status(503).json({ error: 'Desktop sign-in is not configured' })
      return
    }
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { challenge } = req.body as { challenge?: string }
    if (
      typeof challenge !== 'string' ||
      challenge.length < 16 ||
      challenge.length > 256 ||
      !B64URL_RE.test(challenge)
    ) {
      res.status(400).json({ error: 'Invalid PKCE challenge' })
      return
    }
    try {
      const { code, expiresAt } = await desktopAuthStore.create({
        userId,
        challenge,
        ip: req.ip,
      })
      res.json({ code, expiresAt: expiresAt.toISOString() })
    } catch (err) {
      console.error('[auth] desktop code mint failed:', err)
      res.status(500).json({ error: 'Failed to mint desktop code' })
    }
  })

  /** Exchange a single-use code + PKCE verifier for the standard JWT pair. */
  router.post('/desktop/exchange', async (req, res) => {
    if (!desktopAuthStore) {
      res.status(503).json({ error: 'Desktop sign-in is not configured' })
      return
    }
    const { code, verifier } = req.body as { code?: string; verifier?: string }
    if (
      typeof code !== 'string' ||
      code.length < 16 ||
      code.length > 512 ||
      !B64URL_RE.test(code) ||
      typeof verifier !== 'string' ||
      verifier.length < 16 ||
      verifier.length > 256 ||
      !B64URL_RE.test(verifier)
    ) {
      res.status(400).json({ error: 'Invalid code or verifier' })
      return
    }
    try {
      const consumed = await desktopAuthStore.consume(code)
      if (!consumed) {
        res.status(400).json({ error: 'Code is invalid, expired, or already used' })
        return
      }
      // PKCE check: the app proves it started the flow by presenting the
      // verifier whose sha256 matches the challenge bound at mint time.
      const expected = createHash('sha256').update(verifier).digest('base64url')
      if (expected !== consumed.challenge) {
        res.status(400).json({ error: 'PKCE verification failed' })
        return
      }
      const tokens = createTokens(consumed.userId, jwtSecret)
      const user = await findUserById(consumed.userId)
      res.json({
        ...tokens,
        ...(user && {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            avatarUrl: user.avatarUrl,
          },
        }),
      })
    } catch (err) {
      console.error('[auth] desktop exchange failed:', err)
      res.status(500).json({ error: 'Exchange failed' })
    }
  })

  /**
   * Mint a shadow-claim consent token.
   *
   * Called by the consent page (apps/web/src/app/auth/claim/page.tsx)
   * after a logged-in user clicks Approve. Validates that:
   *   - the partner_key exists and is active,
   *   - the shadow exists with auth_provider='channel' and the
   *     auth_provider_id matches `api:<keyId>:<externalUserId>`,
   *   - the shadow isn't the user themselves.
   *
   * Returns a 5-minute single-use token bound to the (real_user, shadow,
   * partner_key) triple. The page redirects back to the partner with this
   * token; the partner exchanges it via POST /api/v1/claim-shadow.
   *
   * See docs/architecture/features/shadow-claim.md.
   */
  router.post('/claim/issue-token', requireAuth(jwtSecret), async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    if (!shadowClaimStore || !apiKeyStore) {
      res.status(503).json({ error: 'shadow_claim_unavailable' })
      return
    }

    const { partnerKeyId, externalUserId, displayLabel } = req.body as {
      partnerKeyId?: unknown
      externalUserId?: unknown
      displayLabel?: unknown
    }
    if (typeof partnerKeyId !== 'string' || partnerKeyId.length === 0) {
      res.status(400).json({ error: 'invalid_input', detail: 'partnerKeyId required' })
      return
    }
    if (typeof externalUserId !== 'string' || externalUserId.length === 0 || externalUserId.length > 256) {
      res.status(400).json({ error: 'invalid_input', detail: 'externalUserId required (1-256 chars)' })
      return
    }
    const labelClean =
      typeof displayLabel === 'string' && displayLabel.length > 0
        ? displayLabel.slice(0, 80)
        : null

    const keyRow = await apiKeyStore.getByIdSystem(partnerKeyId)
    if (!keyRow) {
      res.status(404).json({ error: 'partner_key_not_found' })
      return
    }
    if (keyRow.status !== 'active') {
      res.status(403).json({ error: 'partner_key_revoked' })
      return
    }

    const authProviderId = `api:${keyRow.id}:${externalUserId}`
    const shadow = await query<{ id: string; auth_provider: string }>(
      `SELECT id, auth_provider FROM users
       WHERE auth_provider = 'channel' AND auth_provider_id = $1
       LIMIT 1`,
      [authProviderId],
    )
    if (shadow.rows.length === 0) {
      res.status(404).json({ error: 'shadow_not_found' })
      return
    }
    const shadowUserId = shadow.rows[0].id
    if (shadowUserId === userId) {
      res.status(400).json({ error: 'cannot_merge_self' })
      return
    }

    try {
      const minted = await shadowClaimStore.create({
        realUserId: userId,
        shadowUserId,
        partnerKeyId: keyRow.id,
        externalUserId,
        displayLabel: labelClean,
      })
      res.json({
        claimToken: minted.token,
        expiresAt: minted.expiresAt.toISOString(),
      })
    } catch (err) {
      console.error('[auth/claim] mint failed:', err)
      res.status(500).json({ error: 'internal' })
    }
  })

  return router
}

/**
 * Bind a verified Telegram identity to a user account by creating/updating
 * a row in user_linked_accounts and merging any orphan shadow user.
 *
 * Returns a human-readable warning string if the binding failed — the
 * caller treats this as non-fatal (OAuth sign-in still succeeds).
 */
async function tryLinkTelegram(
  userId: string,
  tgLinkToken: string,
  jwtSecret: string,
  linkedAccountStore: LinkedAccountStore | undefined,
  notifyTelegramLinked: NotifyTelegramLinked | undefined,
): Promise<string | undefined> {
  if (!linkedAccountStore) {
    return 'Telegram link skipped: linking not configured on server'
  }

  const payload = verifyTgLinkToken(tgLinkToken, jwtSecret)
  if (!payload) {
    return 'Telegram link token invalid or expired; please retry from Telegram'
  }

  const assistantRow = await query<{ id: string }>(
    `SELECT id FROM assistants
     WHERE owner_user_id = $1
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId],
  )
  const assistantId = assistantRow.rows[0]?.id
  if (!assistantId) {
    return 'Telegram link skipped: user has no assistant'
  }

  try {
    await linkedAccountStore.upsert({
      userId,
      assistantId,
      provider: 'telegram',
      providerId: payload.tgUserId,
      providerMetadata: { firstName: payload.firstName, chatId: payload.chatId },
    })
  } catch (err) {
    console.error('[auth] tg-link upsert failed:', err)
    return 'Telegram link failed; please retry from Telegram'
  }

  // Fire-and-forget — mirrors the pattern in routes/telegram.ts Step A.
  mergeShadowUser(userId, payload.tgUserId, 'telegram', {
    reason: 'oauth-signup',
    evidence: { chatId: payload.chatId, source: 'tg-link' },
  }).catch((err) => {
    console.error('[auth] tg-link mergeShadowUser failed:', err)
  })

  // Closure signal for the user. On mobile the OAuth round-trip finishes
  // in the system browser, so the in-Telegram WebView never updates — a
  // push from the bot is the only way the user sees "you're linked"
  // without sending a message first.
  if (notifyTelegramLinked) {
    notifyTelegramLinked(payload.chatId, payload.firstName).catch((err) => {
      console.warn('[auth] tg-link notify failed:', err)
    })
  }

  return undefined
}

// ── Email magic-link helpers ──────────────────────────────────

// RFC 5322 super-loose check — we send to whatever passes, then let SMTP
// + the user's mail provider be the real validator. The point is to reject
// obvious garbage early so we don't insert junk rows in the DB.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(s: string): boolean {
  return s.length >= 3 && s.length <= 320 && EMAIL_RE.test(s)
}

// `/invite` carries the workspace-invitation accept page (`?token=` resume);
// `/auth/claim` carries the partner claim flow resume. The desktop sign-in
// bridge travels as an absolute app-origin URL through ALLOWED_NEXT_HOSTS
// below, not this list. Keep in sync with the web verify route and the
// Google OAuth callback.
const ALLOWED_NEXT_PREFIXES = ['/brain', '/studio', '/workflow', '/chat', '/onboarding', '/invite', '/auth/claim']

// Sidan-owned hosts an absolute `nextPath` may target. Lets a magic-link
// sign-in carry a cross-app return (e.g. the desktop bridge at
// `https://app.sidan.ai/desktop/auth?…`) the same way the Google OAuth
// callback does. Mirrors the web `ALLOWED_RETURN_HOSTS` allowlists; keep in sync.
const ALLOWED_NEXT_HOSTS = new Set<string>([
  'sidan.ai',
  'feed.sidan.ai',
  'app.sidan.ai',
  'localhost:3000',
  'localhost:3001',
  'localhost:3003',
])

function isAllowedNextPath(s: string): boolean {
  if (typeof s !== 'string') return false
  if (s.length > 512) return false
  if (s.startsWith('//')) return false
  if (s.startsWith('/')) {
    return ALLOWED_NEXT_PREFIXES.some(
      (p) => s === p || s.startsWith(`${p}/`) || s.startsWith(`${p}?`),
    )
  }
  // Absolute URL: only http(s) on a sidan-owned host (cross-app return, e.g.
  // the desktop sign-in bridge). The host check is the open-redirect guard.
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return ALLOWED_NEXT_HOSTS.has(u.host)
  } catch {
    return false
  }
}

function isMagicLinkLocale(x: unknown): x is MagicLinkLocale {
  return x === 'en' || x === 'ja' || x === 'zh'
}

function pickLocaleFromHeader(h: string | string[] | undefined): MagicLinkLocale {
  const raw = Array.isArray(h) ? h[0] : h
  if (!raw) return 'en'
  // First language tag, lowercased
  const tag = raw.split(',')[0]?.trim().toLowerCase() ?? ''
  if (tag.startsWith('ja')) return 'ja'
  if (tag.startsWith('zh')) return 'zh'
  return 'en'
}

function extractClientIp(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string | undefined {
  // Cloud Run sets X-Forwarded-For. Take the first entry (the original
  // client) before any proxy hops we trust.
  const fwd = req.headers['x-forwarded-for']
  const fwdRaw = Array.isArray(fwd) ? fwd[0] : (typeof fwd === 'string' ? fwd : undefined)
  if (fwdRaw) {
    const first = fwdRaw.split(',')[0]?.trim()
    if (first && first.length < 64) return first
  }
  const remote = req.socket?.remoteAddress
  return remote && remote.length < 64 ? remote : undefined
}

/**
 * Timezone capture — same shape as the Google OAuth route. The validated
 * `X-Client-Timezone` header (attachClientTimezone middleware) takes
 * precedence; the request body field is the fallback when a caller runs
 * server-side without a browser context.
 */
function resolveCaptureTz(headerTz: string | undefined, bodyTimezone: unknown): string | undefined {
  if (headerTz) return headerTz
  const rawBodyTz = typeof bodyTimezone === 'string' ? bodyTimezone.trim() : ''
  return rawBodyTz && rawBodyTz.length > 0 && rawBodyTz.length < 80 && isValidTimezone(rawBodyTz)
    ? rawBodyTz
    : undefined
}

/**
 * Resolve the email → user, mint the JWT pair, and write the standard sign-in
 * response. Shared by the link (`/email/verify`) and passcode
 * (`/email/verify-code`) paths so both produce byte-identical response bodies
 * and can't drift.
 */
async function respondWithEmailSession(
  res: Response,
  jwtSecret: string,
  consumed: MagicLinkConsumed,
  captureTz: string | undefined,
): Promise<void> {
  try {
    const { user, isNew } = await findOrCreateEmailUser(consumed.email, captureTz)
    const tokens = createTokens(user.id, jwtSecret)
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
      isNew,
      nextPath: consumed.nextPath,
      ...tokens,
    })
  } catch (err) {
    console.error('[auth/email] session mint error:', err)
    res.status(500).json({ error: 'Authentication failed' })
  }
}

/**
 * Resolve the user record for an email magic-link sign-in.
 *
 * Three branches:
 *   1. Existing shadow user (auth_provider='channel') with this email →
 *      promote to auth_provider='email' (same pattern as the Google
 *      shadow-promotion branch).
 *   2. Existing real user (auth_provider='google' or 'email') with this
 *      email → return as-is. auth_provider is NOT changed; magic-link
 *      sign-in is treated as an alternate authentication method, not a
 *      provider switch.
 *   3. No existing user → create new with auth_provider='email'.
 *
 * Timezone backfill is applied in branches 1 and 2 when the stored value
 * is still the 'UTC' default (same self-healing logic as the Google
 * shadow-promotion branch).
 */
async function findOrCreateEmailUser(
  email: string,
  captureTz: string | undefined,
): Promise<{ user: User; isNew: boolean }> {
  const existing = await findUserByEmail(email)
  if (existing) {
    if (existing.authProvider === 'channel') {
      await promoteChannelUser(existing.id, {
        authProvider: 'email',
        authProviderId: email,
      })
      if (
        captureTz &&
        captureTz !== 'UTC' &&
        (!existing.timezone || existing.timezone === 'UTC')
      ) {
        await updateUserTimezone(existing.id, captureTz).catch((err) =>
          console.error('[auth/email] shadow tz backfill failed:', err),
        )
        existing.timezone = captureTz
      }
      return {
        user: { ...existing, authProvider: 'email', authProviderId: email },
        isNew: false,
      }
    }
    if (
      captureTz &&
      captureTz !== 'UTC' &&
      (!existing.timezone || existing.timezone === 'UTC')
    ) {
      await updateUserTimezone(existing.id, captureTz).catch((err) =>
        console.error('[auth/email] existing tz backfill failed:', err),
      )
      existing.timezone = captureTz
    }
    return { user: existing, isNew: false }
  }
  return await findOrCreateUser({
    authProvider: 'email',
    authProviderId: email,
    email,
    timezone: captureTz,
  })
}
