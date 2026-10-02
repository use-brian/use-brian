# Mobile browser PKCE handoff (v1)

Implementation: milestone 2 of `watchos-live-recording.md`. Additive to desktop auth; desktop behavior is unchanged.

## Origins and registration

- Browser entry: **app-web origin**, `/mobile/auth`.
- Exchange, refresh and logout: **API origin**, `/auth/mobile/exchange`, `/auth/refresh`, `/auth/logout`. Do not call these on app-web or the portal origin. The deployment supplies/pins these origins; never take an API origin from a callback query.
- Registered client IDs: `brian-ios`, `brian-android`.
- Exact registered redirect URI for both: `usebrian-mobile://auth` (no trailing slash, query, fragment or alternate host). No caller-selected redirect is honored by the web bridge.
- Use HTTPS outside local development. Configure app-web `AUTHED_APP_URL` to its public origin behind ingress; `INTERNAL_API_URL` is the private API hop, not the native client's public API origin. Normal primary-auth/delegated-login configuration still applies.
- Custom schemes do not attest app identity. PKCE prevents another scheme handler redeeming an intercepted code. The displayed platform is a client label, not verified device hardware.

## Native transaction

1. Generate a cryptographically random verifier (RFC 7636, 43–128 ASCII characters from `[A-Za-z0-9._~-]`; recommended 32 random bytes encoded base64url).
2. Compute `challenge = BASE64URL_NO_PADDING(SHA256(ASCII(verifier)))`. Only canonical 43-character S256 challenges are accepted; plain PKCE is unsupported.
3. Independently generate a cryptographically random state (recommended 32 random bytes encoded base64url; wire grammar `[A-Za-z0-9_-]{16,128}`). Retain state, verifier, client ID, fixed redirect and pinned deployment together in the native transaction.
4. Open the system authentication browser at:

   ```text
   https://<app-origin>/mobile/auth?challenge=<S256>&state=<state>&clientId=brian-ios
   ```

5. Accept only the exact registered callback and **verify mandatory state against the pending native transaction before handling either code or error**. Reject missing/mismatched/duplicate state, unsolicited callbacks and completed transactions. The web bridge echoes state; it cannot perform native verification on the client's behalf. Clear native transaction secrets after completion/cancellation.
6. Redeem the code directly at the pinned API origin using the retained verifier and bindings. Never copy browser cookies, browser bearer tokens or bridge secrets into the app.

## Browser confirmation

`GET /mobile/auth` validates required challenge/state/clientId and duplicate parameters. Missing browser credentials or an API-rejected session go through the normal portal login (or the existing explicit OSS local-owner flow), preserving the transaction. There is no mobile-specific insecure login fallback.

For an authenticated browser, `GET /auth/mobile/account` is a bearer-only API read returning `{ user: { id, email, name } }`. The bridge renders that authenticated account and the client platform with explicit confirm/cancel buttons. **GET never mints a code.** Account text is HTML-escaped. English, Japanese, Traditional Chinese and Simplified Chinese copy use the existing dictionaries (server-rendered HTML route, not a React hook).

The form POST goes only to `/mobile/auth`. It requires:

- Exact public app `Origin`, a non-cross-site Fetch Metadata request, and URL-encoded form content.
- A random HttpOnly SameSite=Strict host-only CSRF cookie (`__Host-mobile_auth` with Secure on HTTPS), matching the submitted CSRF value.
- A maximum 10-minute signed confirmation bound to the exact challenge/state/client and the authenticated browser access token. Switching browser account/session or modifying transaction fields invalidates the confirmation.

Confirmation invokes the mint API server-to-server with the human bearer. Cancellation invokes no mint API. Responses are no-store, no-referrer and frame-denied; CSP permits the fixed native callback scheme for the POST redirect. No bearer or refresh tokens enter HTML or callback URLs. Cookie deletion follows a completed callback. Only the code is one-time: submitting a still-valid confirmation twice may mint two distinct independently single-use codes.

Success: HTTP 303 to `usebrian-mobile://auth?code=<code>&state=<state>`.
Cancellation: same fixed callback with `error=access_denied&state=...`.
Mint failures: `error=login_required` (session rejected) or `error=mint_failed`, with state. Invalid initial requests and CSRF failures stay on the web origin with HTTP 400/403; no unvalidated callback is issued. Restart the flow from native after an error.

## API endpoints

### POST `/auth/mobile/code`

Authorization: existing **human** `Authorization: Bearer <accessToken>` with normal session admission. Cookies, watch grants and unauthenticated native requests are not accepted.

```json
{
  "clientId": "brian-ios",
  "redirectUri": "usebrian-mobile://auth",
  "challenge": "<43-character canonical S256 challenge>"
}
```

200: `{ "code": "<32 random bytes, base64url>", "expiresAt": "<ISO timestamp>" }`.

The user is derived exclusively from the bearer. Migration `651_mobile_auth.sql` stores only the SHA-256 code hash, bound user/client/redirect/challenge, creation time, expiry and consumption time. TTL is **120 seconds**. API mint is a bearer-authorized operation, not cookie-authorized; the ambient-browser CSRF boundary is the web confirmation POST.

### POST `/auth/mobile/exchange`

No browser session required. JSON:

```json
{
  "code": "<code from callback>",
  "verifier": "<original native verifier>",
  "clientId": "brian-ios",
  "redirectUri": "usebrian-mobile://auth"
}
```

200: standard `{ accessToken, refreshToken, user: { id, email, name, avatarUrl } }` human session response. Tokens use the existing auth-session store and JWT machinery.

Redemption is **one PostgreSQL UPDATE ... RETURNING**, with hash, client ID, exact redirect, SHA-256(verifier), unused status and expiry all in the WHERE clause. Invalid PKCE or any binding mismatch does not consume the code. Concurrent correct redemptions produce at most one session. Consumption precedes session creation: if session creation fails or the response is lost, the code cannot be retried successfully; restart browser authentication rather than weakening one-time semantics.

Errors: 400 `invalid_mobile_request` (malformed/unregistered input), 400 `invalid_mobile_code` (binding mismatch, missing, expired or consumed code), 503 `mobile_signin_unavailable` (unconfigured store or service failure). Code/exchange responses are no-store. Mint also uses standard human-auth 401/503 responses.

### Refresh and logout

Use existing API `POST /auth/refresh` with `{ refreshToken }`; use returned access/refresh tokens and optional refreshed user. `POST /auth/logout` with `{ refreshToken }` revokes the session. This patch does not change existing refresh rotation semantics. Native must securely persist credentials and coordinate refresh across UI/background services. Phone human refresh tokens must never be provisioned to a watch; watch grants are a separate contract.

## Deployment and verification

Apply migration 651 before serving this feature. `boot.ts` passes `createDbMobileAuthStore()` as the new final optional `authRoutes` dependency, after the existing session store. No watch route wiring was changed by the mobile-auth work.

Used/expired code rows remain inert and may be periodically deleted by deployment maintenance (`DELETE FROM mobile_auth_codes WHERE expires_at < NOW() - INTERVAL '1 day'`). This patch adds no background retention worker. Exclude auth query strings/bodies from proxy logging; do not log codes, verifier, state or credentials. Gateway authentication remains distinct and is not bypassed by this protocol.

Focused checks executed:

- API mobile route tests: 13 passed (bearer-only admission, user binding, input grammar, session creation/failure).
- Real PostgreSQL 18, isolated temporary schema, actual migration + store SQL: 6 passed (hash-only persistence/TTL, invalid verifier not consuming, client/redirect mismatch not consuming, replay/expiry, eight concurrent redeemers with exactly one winner).
- Web route tests: 15 passed (portal continuation, GET does not mint, confirmation, fixed callback/state, CSRF/origin/cookie/session/transaction tampering, expiry, cancel, escaping/localization).
- Existing API auth/logout/desktop-store regression tests: 32 passed.

Commands (from each package):

```sh
# packages/api
node_modules/.bin/vitest run src/routes/__tests__/auth-mobile.test.ts src/routes/__tests__/auth.test.ts src/routes/__tests__/auth-logout.test.ts src/db/__tests__/desktop-auth-store.test.ts
MOBILE_AUTH_TEST_DATABASE_URL=postgres://... node_modules/.bin/vitest run --config vitest.integration.config.ts src/db/__tests__/mobile-auth-store.integration.test.ts
# apps/app-web
node_modules/.bin/vitest run src/app/mobile/auth/route.test.ts
```

Integration tests explicitly skip without `MOBILE_AUTH_TEST_DATABASE_URL`; they create/drop only a unique schema. Full package typechecks currently fail on unrelated workspace dependency/type errors; targeted mobile files were checked in their diagnostic output. Real portal/provider round-trip and iOS/Android system-browser custom-scheme delivery still require deployment/device smoke tests. Component tags: `api/auth`, `api/mobile-auth-store`, `app-web/mobile-auth-bridge` (component-map is outside this task's ownership).
