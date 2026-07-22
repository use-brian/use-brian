/**
 * Absolute API origin for URLs DISPLAYED to the user (copy fields, webhook
 * URLs, MCP endpoints, Slack manifests) — anything a human pastes into an
 * external tool.
 *
 * Why this exists: in local dev `next.config.ts` deliberately blanks
 * `NEXT_PUBLIC_API_URL` and proxies `/api/*` to the API service through a
 * rewrite (commit a83d1418). That is correct for `authFetch` calls (they
 * ride same-origin through the proxy) but wrong for displayed URLs — an
 * external client (Claude Desktop, Slack, a partner backend) cannot use a
 * path relative to the app origin. `NEXT_PUBLIC_DISPLAY_API_URL` is inlined by
 * next.config's `env` block and always carries the real origin, so the chain
 * below never collapses to a bare path; `||` (not `??`) so the dev empty string
 * falls through.
 *
 * This deliberately does NOT fall back to `API_URL`. Client components import
 * this constant, so the value must be inlined at build time — and `API_URL` is
 * now runtime-only, resolving to `undefined` in a browser bundle. It is also the
 * wrong value on a self-host, where the server-side origin may be a private one
 * no external client can reach (see lib/internal-api-url.ts).
 *
 * Rule of thumb: machine-to-machine hops use `INTERNAL_API_URL`; anything
 * rendered, copied, or embedded in config a user exports uses THIS constant.
 */
export const DISPLAY_API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_DISPLAY_API_URL ||
  "http://localhost:4000";
