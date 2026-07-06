import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

/**
 * Google OAuth callback for connector consent (Calendar, Gmail, Drive) —
 * app-web copy.
 *
 * Ported from `apps/web/src/app/api/auth/callback/google-connector/route.ts`
 * (app consolidation §9 #5). Same pattern: exchange the code for tokens with
 * Google, forward the refresh token to the Express backend, then redirect
 * back to Studio -> Connectors.
 *
 * app-web delta: routes are workspace-scoped (`/w/<workspaceId>/studio/
 * connectors`), so the connectors page threads the active workspace id into
 * `state` as `<connector>:<workspaceId>`. This callback parses both halves and
 * redirects to the workspace-scoped route. A missing workspace id falls back
 * to `/teams`.
 *
 * INFRA (degraded): requires `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and a
 * `app.sidan.ai/...` redirect_uri allowlisted in the Google OAuth client.
 * Doc-web does not set the connector `NEXT_PUBLIC_GOOGLE_CLIENT_ID` env yet,
 * so the connect button can't reach this callback until that lands.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? ""; // "gcal[:add]:<workspaceId>"
  const error = url.searchParams.get("error");

  const { connector, createNew, workspaceId } = parseState(stateRaw);

  if (error || !code || !connector) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "consent_denied" }), request.url),
    );
  }

  try {
    const origin = new URL(request.url).origin;
    const redirectUri = `${origin}/api/auth/callback/google-connector`;

    // Exchange code for tokens with Google
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      console.error("[google-connector] token exchange failed:", await tokenRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "token_exchange_failed" }), request.url),
      );
    }

    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
    };

    if (!tokens.refresh_token) {
      console.error("[google-connector] no refresh_token returned");
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "no_refresh_token" }), request.url),
      );
    }

    // Fetch the connected Google account's email
    let connectedEmail: string | undefined;
    if (tokens.access_token) {
      try {
        const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (userInfoRes.ok) {
          const userInfo = (await userInfoRes.json()) as { email?: string };
          connectedEmail = userInfo.email;
        }
      } catch (err) {
        console.error("[google-connector] failed to fetch user email:", err);
      }
    }

    // Send refresh token to Express backend to store in the connector row
    const cookieStore = await cookies();
    const accessToken = cookieStore.get("access_token")?.value;
    if (!accessToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // `createNew` ("Add another" intent) makes the backend mint a FRESH
    // connector_instance instead of updating the first — the connected
    // email doubles as the new instance's nickname so two accounts are
    // tellable apart on the rail.
    const storeRes = await fetch(`${API_URL}/api/connectors/${connector}/store-credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        refreshToken: tokens.refresh_token,
        email: connectedEmail,
        ...(createNew ? { createNew: true, label: connectedEmail } : {}),
      }),
    });

    if (!storeRes.ok) {
      console.error("[google-connector] store credentials failed:", await storeRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "store_failed" }), request.url),
      );
    }

    // Thread the minted/reconnected instance UUID back to the connectors
    // page — the auto-expose must act on THIS instance, and a bare slug is
    // ambiguous once the provider has a second account.
    const stored = (await storeRes.json().catch(() => ({}))) as {
      connectorInstanceId?: string;
    };

    return NextResponse.redirect(
      new URL(
        connectorsPath(workspaceId, {
          connected: connector,
          instance: stored.connectorInstanceId,
        }),
        request.url,
      ),
    );
  } catch (err) {
    console.error("[google-connector] callback error:", err);
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "unexpected" }), request.url),
    );
  }
}

/**
 * Parse the `state` param — `<connector>[:add]:<workspaceId>` (the same
 * shape the Notion/Fathom callbacks parse). `:add` is the "Add another"
 * intent: store a NEW connector_instance rather than updating the first.
 * A bare slug (no `:`) keeps `workspaceId` undefined.
 */
function parseState(raw: string): {
  connector: string;
  createNew: boolean;
  workspaceId: string | undefined;
} {
  const idx = raw.indexOf(":");
  if (idx === -1) return { connector: raw, createNew: false, workspaceId: undefined };
  let rest = raw.slice(idx + 1);
  const createNew = rest === "add" || rest.startsWith("add:");
  if (createNew) rest = rest.slice("add".length + (rest.startsWith("add:") ? 1 : 0));
  return { connector: raw.slice(0, idx), createNew, workspaceId: rest || undefined };
}

/**
 * Build the workspace-scoped connectors path. Falls back to `/teams` when the
 * workspace id is missing (so the user can re-pick a workspace).
 */
function connectorsPath(
  workspaceId: string | undefined,
  query: { connected?: string; instance?: string; error?: string },
): string {
  if (!workspaceId) return "/teams";
  const sp = new URLSearchParams();
  if (query.connected) sp.set("connected", query.connected);
  if (query.instance) sp.set("instance", query.instance);
  if (query.error) sp.set("error", query.error);
  const qs = sp.toString();
  return `/w/${workspaceId}/studio/connectors${qs ? `?${qs}` : ""}`;
}
