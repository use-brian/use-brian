import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const FATHOM_CLIENT_ID = process.env.NEXT_PUBLIC_FATHOM_CLIENT_ID ?? "";
const FATHOM_CLIENT_SECRET = process.env.FATHOM_CLIENT_SECRET ?? "";

const FATHOM_TOKEN_URL = "https://api.fathom.ai/external/v1/oauth2/token";
const FATHOM_API_BASE = "https://api.fathom.ai/external/v1";

/**
 * Fathom OAuth callback for the meeting-notes connector — app-web copy.
 *
 * Ported from `apps/web/src/app/api/auth/callback/fathom/route.ts`
 * (app consolidation §9 #5). Exchanges the authorization code server-side,
 * fetches the connected user's email for the Settings UI, then POSTs the
 * encrypted token tuple to `/api/connectors/fathom/store-credentials`.
 *
 * app-web delta: the connectors page threads the active workspace id into
 * `state` (`fathom:<workspaceId>` or `fathom:add:<workspaceId>`). This callback
 * parses the intent + workspace id and redirects to the workspace-scoped route.
 *
 * INFRA (degraded): requires `NEXT_PUBLIC_FATHOM_CLIENT_ID` /
 * `FATHOM_CLIENT_SECRET` and a `app.sidan.ai/...` redirect_uri allowlisted
 * with Fathom. Doc-web does not set these yet, so the connect button can't
 * reach this callback until that lands.
 *
 * See docs/architecture/integrations/fathom.md.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? ""; // "fathom[:add]:<workspaceId>"
  const error = url.searchParams.get("error");

  const { intent, createNew, workspaceId } = parseState(stateRaw);
  const validIntent = intent === "fathom";

  if (error || !code || !validIntent) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "consent_denied" }), request.url),
    );
  }

  try {
    const origin = new URL(request.url).origin;
    const redirectUri = `${origin}/api/auth/callback/fathom`;

    const tokenRes = await fetch(FATHOM_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: FATHOM_CLIENT_ID,
        client_secret: FATHOM_CLIENT_SECRET,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      console.error("[fathom] token exchange failed:", await tokenRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "token_exchange_failed" }), request.url),
      );
    }

    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error("[fathom] incomplete token response");
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "no_access_token" }), request.url),
      );
    }

    const expiresInMs = Math.max(0, (tokens.expires_in ?? 3600) * 1000);
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

    // Best-effort fetch of the connected user's email for the Settings UI.
    let connectedEmail: string | undefined;
    try {
      const meRes = await fetch(`${FATHOM_API_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (meRes.ok) {
        const me = (await meRes.json()) as {
          email?: string;
          user?: { email?: string };
        };
        connectedEmail = me.email ?? me.user?.email;
      }
    } catch (err) {
      console.error("[fathom] users/me fetch failed:", err);
    }

    const cookieStore = await cookies();
    const accessToken = cookieStore.get("access_token")?.value;
    if (!accessToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const storeRes = await fetch(
      `${API_URL}/api/connectors/fathom/store-credentials`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          fathomTokens: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt,
          },
          email: connectedEmail,
          createNew,
          label: createNew ? connectedEmail : undefined,
        }),
      },
    );

    if (!storeRes.ok) {
      console.error("[fathom] store credentials failed:", await storeRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "store_failed" }), request.url),
      );
    }

    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { connected: "fathom" }), request.url),
    );
  } catch (err) {
    console.error("[fathom] callback error:", err);
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "unexpected" }), request.url),
    );
  }
}

/**
 * Parse `state` of the form `fathom[:add]:<workspaceId>` into its parts.
 * `:add` → connect a SECOND Fathom account (create a new instance).
 */
function parseState(raw: string): {
  intent: string;
  createNew: boolean;
  workspaceId: string | undefined;
} {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon === -1) {
    return { intent: raw, createNew: false, workspaceId: undefined };
  }
  const prefix = raw.slice(0, lastColon);
  const workspaceId = raw.slice(lastColon + 1) || undefined;
  const createNew = prefix.endsWith(":add");
  const intent = createNew ? prefix.slice(0, -":add".length) : prefix;
  return { intent, createNew, workspaceId };
}

function connectorsPath(
  workspaceId: string | undefined,
  query: { connected?: string; error?: string },
): string {
  if (!workspaceId) return "/teams";
  const sp = new URLSearchParams();
  if (query.connected) sp.set("connected", query.connected);
  if (query.error) sp.set("error", query.error);
  const qs = sp.toString();
  return `/w/${workspaceId}/studio/connectors${qs ? `?${qs}` : ""}`;
}
