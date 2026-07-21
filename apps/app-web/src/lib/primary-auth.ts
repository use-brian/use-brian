/**
 * Where does primary auth live?
 *
 * Per the design rule "usebrian.ai → sub-app, not the other way round",
 * only `usebrian.ai` writes the shared `Domain=.usebrian.ai` auth cookies.
 * This sub-app (`feed-web`) bounces the browser to usebrian.ai for any
 * auth state change — OAuth, refresh, logout — and then catches the
 * round-trip back via a `next=` query param.
 *
 * In dev the browser sees `localhost:3000` and `localhost:3001` as
 * separate origins with no shared cookie scope, so cross-origin
 * redirects would mean every login wipes out the local session. We
 * fall back to the sub-app's own OAuth flow when this returns `null`.
 *
 * Production deploys set `NEXT_PUBLIC_PRIMARY_AUTH_URL=https://usebrian.ai`
 * via the app's env config. We default to that when `NODE_ENV` is
 * `production` so the bare deploy still works without an explicit env
 * override — the override exists for staging deployments under a
 * different apex.
 *
 * Same allowlist as `/api/auth/refresh-and-return` and
 * `/api/auth/logout` on usebrian.ai; if you change one, change the others.
 */

import { isOssEdition } from "@/lib/edition";

const ENV_PRIMARY_AUTH_URL = process.env.NEXT_PUBLIC_PRIMARY_AUTH_URL;
const DEFAULT_PROD_PRIMARY_AUTH_URL = "https://usebrian.ai";

export function primaryAuthUrl(): string | null {
  // The open single-player edition owns auth locally (the local-owner session),
  // so it never delegates to a primary — including in a production build, where
  // `next build` freezes NODE_ENV to "production" and the check below would
  // otherwise wrongly bounce every self-hosted user to usebrian.ai.
  if (isOssEdition()) {
    return null;
  }
  if (ENV_PRIMARY_AUTH_URL && ENV_PRIMARY_AUTH_URL.length > 0) {
    return ENV_PRIMARY_AUTH_URL;
  }
  if (process.env.NODE_ENV === "production") {
    return DEFAULT_PROD_PRIMARY_AUTH_URL;
  }
  return null;
}

/**
 * Base URL of the main marketing + auth-entry web app (`apps/web`, `usebrian.ai`),
 * where deep account/plan config lives. App-web deep-links a few of its routes
 * (e.g. `/plans`).
 *
 * `NEXT_PUBLIC_APP_URL` overrides it; otherwise we reuse `primaryAuthUrl()`
 * (which resolves to `https://usebrian.ai` in production) before falling back to
 * the dev origin. Routing the default through `primaryAuthUrl()` is what stops
 * an unset prod env var from pointing users at `http://localhost:3000` — the
 * bug that sent prod redeem/upgrade clicks to a dev URL. Every app→marketing
 * deep-link must read this, never an inline `?? "http://localhost:3000"`.
 */
export function webAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    primaryAuthUrl() ??
    "http://localhost:3000"
  );
}

/**
 * Build a cross-origin auth URL of the form
 * `${primary}/<path>?next=<currentUrl>`. Callers pass the path the
 * primary should hit (`/login`, `/api/auth/refresh-and-return`,
 * `/api/auth/logout`) and the URL we want the user back at after.
 *
 * Returns null when there is no primary (dev), so callers can fall back
 * to the local route.
 */
export function buildPrimaryAuthUrl(path: string, nextUrl: string): string | null {
  const primary = primaryAuthUrl();
  if (!primary) return null;
  const u = new URL(path, primary);
  u.searchParams.set("next", nextUrl);
  return u.toString();
}
