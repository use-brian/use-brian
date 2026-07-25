/**
 * Provider-neutral deployment-gateway detection for self-hosted targets.
 *
 * The shell knows the response contract of its discovery and health endpoints,
 * so it can identify an interactive login page without knowing the gateway's
 * domains, headers, or cookie names. Electron BrowserWindow/session IO stays in
 * main.ts; this module is pure and fetch-injectable.
 *
 * Spec: docs/architecture/features/app-desktop.md → "Deployment-gateway authentication"
 * [COMP:app-desktop/gateway-auth]
 */

export type GatewayProbeResult =
  | { kind: "ok"; body: unknown }
  | { kind: "missing" }
  | { kind: "authentication-required" }
  | { kind: "failed" };

type ProbeResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type GatewayProbeFetch = (
  input: string,
  init: RequestInit,
) => Promise<ProbeResponse>;

export type GatewayProbeOptions = {
  allowNotFound?: boolean;
  timeoutMs?: number;
  fetchImpl?: GatewayProbeFetch;
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const AUTH_STATUS = new Set([401, 403, 407]);
const HTTP_AUTH_SCHEME = /^(?:basic|digest|negotiate|ntlm)\b/i;

function looksLikeHtml(body: string, contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("text/html") === true || /^\s*</.test(body);
}

/**
 * Request an endpoint that must return JSON and classify common interactive
 * gateway responses. Redirects stay manual so an IdP's eventual 200 HTML page
 * can never be mistaken for the endpoint's success response.
 */
export async function probeExpectedJson(
  url: string,
  options: GatewayProbeOptions = {},
): Promise<GatewayProbeResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as GatewayProbeFetch);
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3500),
    });

    const authScheme = response.headers.get(
      response.status === 407 ? "proxy-authenticate" : "www-authenticate",
    );
    if (
      (response.status === 401 || response.status === 407) &&
      HTTP_AUTH_SCHEME.test(authScheme?.trim() ?? "")
    ) {
      // Electron cancels HTTP auth unless the app supplies credentials through
      // its `login` event. This shell has no credential UI, so fail instead of
      // opening an authentication window that can never complete.
      return { kind: "failed" };
    }
    if (REDIRECT_STATUS.has(response.status) || AUTH_STATUS.has(response.status)) {
      return { kind: "authentication-required" };
    }
    if (options.allowNotFound && response.status === 404) return { kind: "missing" };

    const raw = await response.text();
    if (!response.ok) return { kind: "failed" };

    try {
      return { kind: "ok", body: JSON.parse(raw) as unknown };
    } catch {
      return looksLikeHtml(raw, response.headers.get("content-type"))
        ? { kind: "authentication-required" }
        : { kind: "failed" };
    }
  } catch {
    return { kind: "failed" };
  }
}

/** The exact public `/health` response contract used by the API. */
export function isHealthyDocument(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).status === "ok"
  );
}

/**
 * Gateway auth may traverse arbitrary HTTP(S) identity-provider origins, but it
 * must never become a custom-protocol launcher or downgrade an HTTPS target.
 */
export function isAllowedGatewayNavigation(targetUrl: string, protectedUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const protectedTarget = new URL(protectedUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    return protectedTarget.protocol !== "https:" || target.protocol === "https:";
  } catch {
    return false;
  }
}
