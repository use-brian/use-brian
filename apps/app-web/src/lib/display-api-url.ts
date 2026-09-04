import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Absolute API origin for URLs DISPLAYED to the user (copy fields, webhook
 * URLs, MCP endpoints, Slack manifests) — anything a human pastes into an
 * external tool.
 *
 * Why this exists: in local dev `next.config.ts` deliberately blanks
 * an empty public API URL and proxies `/api/*` to the API service through a
 * rewrite (commit a83d1418). That is correct for `authFetch` calls (they
 * ride same-origin through the proxy) but wrong for displayed URLs — an
 * external client (Claude Desktop, Slack, a partner backend) cannot use a
 * path relative to the app origin. Runtime config carries a separate absolute
 * display origin so copied URLs never collapse to a bare path.
 *
 * This deliberately does NOT fall back to `API_URL`. Client components import
 * this constant, so it reads the server-injected browser runtime config. `API_URL`
 * remains server-only. It is also the
 * wrong value on a self-host, where the server-side origin may be a private one
 * no external client can reach (see lib/internal-api-url.ts).
 *
 * Rule of thumb: machine-to-machine hops use `INTERNAL_API_URL`; anything
 * rendered, copied, or embedded in config a user exports uses THIS constant.
 */
export const DISPLAY_API_URL = publicRuntimeConfig().displayApiUrl;
