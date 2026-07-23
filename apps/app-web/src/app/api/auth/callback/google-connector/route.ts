import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CONNECTOR_OAUTH_STATE_COOKIE,
  parseConnectorState,
  verifyConnectorState,
} from "@/lib/connector-oauth-state";
import { parseDesktopConnectorState, buildLoopbackForwardUrl } from "@/lib/connector-oauth-desktop";

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
 * `app.usebrian.ai/...` redirect_uri allowlisted in the Google OAuth client.
 * Doc-web does not set the connector `NEXT_PUBLIC_GOOGLE_CLIENT_ID` env yet,
 * so the connect button can't reach this callback until that lands.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? ""; // "gcal[:add]:<workspaceId>:<nonce>"
  const error = url.searchParams.get("error");

  // Desktop (Electron) path: the shell drove an RFC 8252 loopback flow and put
  // its loopback + CSRF nonce in `state`. Forward the raw code straight back to
  // the shell over loopback — it does the token exchange + store with its OWN
  // session, because the browser-cookie CSRF the web path uses can't survive the
  // Electron→system-browser jar split. CSRF here is the loopback nonce, which the
  // shell verifies. Spec: docs/plans/desktop-connector-oauth-return.md.
  const desktopState = parseDesktopConnectorState(stateRaw);
  if (desktopState) {
    const forward = buildLoopbackForwardUrl(desktopState, { code, error });
    if (!forward) {
      // Tampered/invalid loopback — never 302 to a non-loopback host.
      return NextResponse.redirect(
        new URL(connectorsPath(desktopState.workspaceId, { error: "invalid_state" }), request.url),
      );
    }
    return NextResponse.redirect(forward);
  }

  const { connector, createNew, instanceId, workspaceId, nonce } = parseConnectorState(stateRaw);

  if (error || !code || !connector) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "consent_denied" }), request.url),
    );
  }

  // CSRF gate (WS3 #5): the `state` nonce must match the companion cookie the
  // connect handler set before redirecting. A forged callback (attacker-planted
  // `code`, absent/mismatched nonce) is rejected here BEFORE any token exchange
  // or store, so an attacker cannot bind their token to the victim's account.
  const cookieStore = await cookies();
  const cookieNonce = cookieStore.get(CONNECTOR_OAUTH_STATE_COOKIE)?.value;
  if (!verifyConnectorState({ stateNonce: nonce, cookieNonce })) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "invalid_state" }), request.url),
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
    const accessToken = cookieStore.get("access_token")?.value;
    if (!accessToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // `instanceId` (reconnect) re-points an EXISTING instance's credential —
    // used when a cleared teammate re-auths a workspace-owned OAuth connector
    // onto their own account. `createNew` ("Add another") mints a FRESH
    // instance (the connected email doubles as its nickname). The two are
    // mutually exclusive; reconnect wins.
    const storeRes = await fetch(`${API_URL}/api/connectors/${connector}/store-credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        refreshToken: tokens.refresh_token,
        email: connectedEmail,
        ...(instanceId
          ? { instanceId }
          : createNew
            ? { createNew: true, label: connectedEmail }
            : {}),
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
