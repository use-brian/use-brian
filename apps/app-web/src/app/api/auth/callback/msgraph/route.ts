import { INTERNAL_API_URL } from "@/lib/internal-api-url";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CONNECTOR_OAUTH_STATE_COOKIE,
  parseConnectorState,
  verifyConnectorState,
} from "@/lib/connector-oauth-state";

/**
 * Microsoft Graph OAuth callback for the `msgraph` (Microsoft Teams) connector.
 *
 * This route does **two** things and deliberately no more: it verifies the
 * double-submit `conn_oauth_state` nonce (the only job that needs this app's
 * cookie), and it forwards the raw code to
 * `POST /api/connectors/msgraph/oauth-callback`.
 *
 * The exchange used to happen here, against `MSGRAPH_CLIENT_ID` /
 * `MSGRAPH_CLIENT_SECRET` from this app's environment. It moved to the API for
 * the reason `/shopify/oauth-callback` states: the client secret may be a
 * CUSTOMER's - their own Entra registration, stored encrypted against their
 * workspace (`connector_app_credentials`, migration 394) - and app-web has no
 * database to read it from. On the hosted product it is not merely unwise but
 * impossible: nobody can put a per-workspace secret in a build-time env var.
 *
 * That move also fixed a hosted-only break. The old shape POSTed the exchanged
 * tuple to `/api/connectors/msgraph/store-credentials`, and the closed router
 * has no `msgraph` branch there - it fell through to the Google `else`, looked
 * for a `refreshToken` field this callback never sent, and answered 400 "Token
 * is required". Microsoft Teams could not connect on app.usebrian.ai at all.
 *
 * See docs/architecture/integrations/msgraph.md → "Auth".
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? ""; // "msgraph[:add]:<workspaceId>:<nonce>"
  const error = url.searchParams.get("error");

  const { connector: intent, createNew, instanceId, workspaceId, nonce } = parseConnectorState(stateRaw);
  const validIntent = intent === "msgraph";

  if (error || !code || !validIntent) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "consent_denied" }), request.url),
    );
  }

  // CSRF gate (WS3 #5): the `state` nonce must match the companion cookie set
  // before the provider redirect; reject a forged callback before the exchange
  // so an attacker's token can't be bound to the victim.
  const cookieStore = await cookies();
  const cookieNonce = cookieStore.get(CONNECTOR_OAUTH_STATE_COOKIE)?.value;
  if (!verifyConnectorState({ stateNonce: nonce, cookieNonce })) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "invalid_state" }), request.url),
    );
  }

  const accessToken = cookieStore.get("access_token")?.value;
  if (!accessToken) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    // Must be byte-identical to the `redirect_uri` the authorize call sent -
    // Entra compares them, and a mismatch surfaces as AADSTS50011 rather than
    // as anything about the code.
    const redirectUri = `${new URL(request.url).origin}/api/auth/callback/msgraph`;

    const exchangeRes = await fetch(`${INTERNAL_API_URL}/api/connectors/msgraph/oauth-callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        code,
        redirectUri,
        // The workspace decides WHICH Entra app the exchange resolves against,
        // so a workspace-owned registration is only findable when this is sent.
        ...(workspaceId ? { workspaceId } : {}),
        // Reconnect re-points the existing row; otherwise connect / add-another.
        ...(instanceId ? { instanceId } : { createNew }),
      }),
    });

    if (!exchangeRes.ok) {
      const detail = await exchangeRes.text();
      console.error("[msgraph] exchange failed:", detail);
      // `app_credentials_missing` is the one failure the user can act on: no
      // app is registered for this workspace and none is configured on the
      // server. Everything else is opaque and reads as a generic failure.
      const reason = detail.includes("app_credentials_missing")
        ? "app_credentials_missing"
        : "token_exchange_failed";
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: reason }), request.url),
      );
    }

    // Thread the minted/reconnected instance UUID back to the connectors
    // page - the auto-expose must act on THIS instance, and a bare slug is
    // ambiguous once the provider has a second account.
    const stored = (await exchangeRes.json().catch(() => ({}))) as {
      connectorInstanceId?: string;
    };

    return NextResponse.redirect(
      new URL(
        connectorsPath(workspaceId, {
          connected: "msgraph",
          instance: stored.connectorInstanceId,
        }),
        request.url,
      ),
    );
  } catch (err) {
    console.error("[msgraph] callback error:", err);
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "unexpected" }), request.url),
    );
  }
}

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
