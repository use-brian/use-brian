/**
 * API origin for app-web's own SERVER-side calls to the API service — the
 * machine-to-machine hops: the proxy's token refresh, the `/api/auth/*` route
 * handlers, `lib/server-fetch.ts`. Nothing here is ever rendered.
 *
 * Why this is not `API_URL`: those two origins are the same in a cloud deploy
 * and deliberately different in a self-host. On a single-box deploy app-web and
 * the API are the same machine, so the server-side hop should stay on
 * `localhost` — while the BROWSER still has to dial the public hostname, because
 * it isn't on that box. One variable cannot express both.
 *
 * Collapsing them is not merely slower, it's fragile: routing app-web's own
 * sign-in fetch back out through the public hostname puts the CDN in the path of
 * a call that never left the building. A Cloudflare Access policy on that
 * hostname then answers the fetch with a 200 HTML login page, and the handler
 * dies on `JSON.parse` ("Unexpected token '<'"). Sign-in breaks from an edge
 * config change that touched no code.
 *
 * Resolution order — unset is the common case and keeps prior behavior:
 *   1. `INTERNAL_API_URL`  — set this when the API is reachable privately.
 *   2. `API_URL`           — the public origin; correct when there's no private path.
 *   3. `http://localhost:4000` — the dev default.
 *
 * Read at RUNTIME, never inlined by next.config's `env` block: the value must
 * follow the deploy, not the build host. See the comment there.
 *
 * For URLs shown to a user, use `DISPLAY_API_URL` (lib/display-api-url.ts).
 */
export const INTERNAL_API_URL =
  process.env.INTERNAL_API_URL ?? process.env.API_URL ?? "http://localhost:4000";
