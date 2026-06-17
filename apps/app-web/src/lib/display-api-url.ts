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
 * path relative to the app origin. `API_URL` is inlined by next.config's
 * `env` block and always carries the real origin, so the chain below never
 * collapses to a bare path; `||` (not `??`) so the dev empty string falls
 * through.
 *
 * Rule of thumb: `authFetch(...)` keeps each SDK's own `API_URL` constant;
 * anything rendered, copied, or embedded in config a user exports uses
 * THIS constant.
 */
export const DISPLAY_API_URL =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || "http://localhost:4000";
