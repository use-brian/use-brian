# Outpost Auth Portal

Customer-owned primary authentication for multi-user Outpost deployments.
It provides email magic-link/OTP sign-in, invitation acceptance, token refresh,
logout, and `/health`. It does not contain marketing, billing, onboarding,
Google/Telegram login, or product UI.

## Development

```bash
INTERNAL_API_URL=http://127.0.0.1:4000 \
AUTH_PORTAL_URL=http://localhost:3005 \
AUTHED_APP_URL=http://localhost:3003 \
pnpm --filter @use-brian/auth-web dev
```

Production additionally requires an isolated cookie suffix shared only by the
portal and app origins:

```bash
INTERNAL_API_URL=http://127.0.0.1:4000
AUTH_PORTAL_URL=https://auth.brian.customer.example
AUTHED_APP_URL=https://app.brian.customer.example
COOKIE_DOMAIN=.brian.customer.example
TRUST_PROXY_HEADERS=true
```

The API runs with `USEBRIAN_EDITION=outpost`. Configure
`OUTPOST_AUTH_BOOTSTRAP_EMAILS` for the initial administrator. Existing users
and recipients of live workspace invitations can then sign in; arbitrary new
email addresses receive the same no-enumeration response but no credential.
Set `TRUST_PROXY_HEADERS=true` only when the ingress removes client-supplied
`CF-Connecting-IP`, `X-Real-IP`, and `X-Forwarded-For` values before adding its
own trusted value.

Email and one discovery-based OIDC connection are independently controlled.
Email defaults on and OIDC off:

```bash
OUTPOST_AUTH_EMAIL_ENABLED=true
OUTPOST_AUTH_OIDC_ENABLED=false
OUTPOST_OIDC_ISSUER_URL=https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-id
OUTPOST_OIDC_CLIENT_ID=client-id
OUTPOST_OIDC_CLIENT_SECRET=client-secret
OUTPOST_OIDC_PROVIDER_NAME=Cloudflare Access
OUTPOST_OIDC_ALLOWED_ENDPOINT_ORIGINS=
OUTPOST_OIDC_EMAIL_VERIFICATION=claim
OUTPOST_AUTH_BRIDGE_SECRET=<at-least-32-random-characters>
```

For Cloudflare, create an Access for SaaS application using OIDC and register
`$AUTH_PORTAL_URL/api/auth/oidc/callback`. A self-hosted Access application's
`Cf-Access-Jwt-Assertion` is a different integration and is not accepted here.
