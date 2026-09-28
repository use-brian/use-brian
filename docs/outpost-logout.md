# Outpost logout

## Failure mechanism

Investigated against use-brian develop `8aba89cd` and hire-brian main `a6143c5`.
The native and Compose Outpost configurations point app-web at auth-web and
share the configured cookie domain. There is no separate token-issuing proxy.

App-web's logout action makes a best-effort access-authenticated device-session
revocation, then navigates to the primary's `/api/auth/logout`. In Outpost that
GET opens a confirmation page; only its POST signs out. Previously the POST
only deleted cookies. If browser-side revocation failed or the portal was used
directly, the server-side refresh session remained valid. A retained refresh
token or a refresh response arriving after cookie deletion could restore access.
This is a source-level defect; no production browser trace was available to
identify which trigger occurred on the reported host.

## Contract

- Logout GET remains non-mutating. Confirmation POST retains origin/fetch-site
  checks and return-origin validation.
- The portal sends its HttpOnly refresh token to `POST /auth/logout` before
  expiring host-only and shared-domain access, refresh, and user cookies.
- The API verifies the refresh JWT and revokes its owned session idempotently.
  An expired access token or earlier client-side revocation does not block it.
- Revoked sessions fail both access admission and refresh, including tokens
  returned by a refresh request already in flight at logout.
- Legacy JWTs without a session ID require account-wide invalidation. The
  conditional auth-version bump prevents replay from revoking a later login;
  legacy refresh cannot adopt a newer version across concurrent logout.
- Invalid/expired refresh tokens can be cleared. Network/backend failures show
  a localized retry instead of reporting success or re-entering app refresh.
- This ends the Brian session, not the external OIDC provider's SSO session.

## Rollout and verification

Deploy API and auth-web together from a revision containing this fix. No cookie
or proxy configuration change is needed for the stock hire-brian setup. A new
portal with an old API reports a retryable failure rather than silently falling
back to cookie-only logout.

Regression coverage:

```sh
pnpm --filter @use-brian/api^... run build
pnpm --filter @use-brian/api exec vitest run src/routes/__tests__/auth-logout.test.ts src/db/__tests__/auth-session-store.test.ts src/auth/__tests__/jwt.test.ts src/auth/__tests__/middleware.test.ts
pnpm --filter @use-brian/auth-web test
```

On the deployed host, sign in, choose Log out, confirm at the portal, then reload
the app. It must request authentication; a pre-logout refresh token must receive
401 from `/auth/refresh`. Check that the ingress preserves all six separate
cookie-deletion headers when a shared cookie domain is configured. Never put
real tokens into logs or tickets.
