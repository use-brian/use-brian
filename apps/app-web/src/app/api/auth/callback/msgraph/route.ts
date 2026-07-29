import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CONNECTOR_OAUTH_STATE_COOKIE,
  parseConnectorState,
  verifyConnectorState,
} from "@/lib/connector-oauth-state";
import {
  MSGRAPH_TOKEN_URL,
  decodeMsGraphIdToken,
  msGraphScopes,
} from "@/lib/msgraph-oauth";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
// Server side, so prefer the canonical unprefixed name the API's
// `getConnectorConfig('msgraph')` reads; the NEXT_PUBLIC_ mirror is the
// fallback for a deploy that only set the browser-side var.
const MSGRAPH_CLIENT_ID =
  process.env.MSGRAPH_CLIENT_ID || process.env.NEXT_PUBLIC_MSGRAPH_CLIENT_ID || "";
const MSGRAPH_CLIENT_SECRET = process.env.MSGRAPH_CLIENT_SECRET ?? "";

/**
 * Microsoft Graph OAuth callback for the `msgraph` (Microsoft Teams) connector.
 *
 * Cloned from `callback/notion/route.ts` - same skeleton: intent guard, the
 * double-submit `conn_oauth_state` nonce CSRF gate BEFORE any token exchange,
 * code exchange, POST to `/api/connectors/msgraph/store-credentials`, redirect
 * back into the workspace-scoped Studio route.
 *
 * Microsoft deltas:
 *  - Form-encoded exchange (Notion uses HTTP Basic + JSON); Google and Fathom
 *    are form-encoded, this follows those.
 *  - The refresh token is REQUIRED, not optional. Graph rotates it on every
 *    refresh, so a connection stored without one dies at the first refresh with
 *    no way back except reconnecting.
 *  - Tenant id and the connected address are read from the `id_token` claims
 *    rather than from a `/me` round trip.
 *
 * The exchange is written out inline rather than calling
 * `exchangeMsGraphAuthorizationCode` from `packages/api/src/msgraph/token.ts`:
 * app-web cannot import the Express package (same split as
 * `verifyShopifyOAuthQueryHmac`). The two must stay in sync - both post
 * form-encoded to `/{tenant}/oauth2/v2.0/token` and both treat the tuple as
 * rotating. The stored envelope is exactly what `unpackMsGraphTokens` reads.
 *
 * INFRA: requires `NEXT_PUBLIC_MSGRAPH_CLIENT_ID` / `MSGRAPH_CLIENT_SECRET` and
 * an `app.usebrian.ai/api/auth/callback/msgraph` redirect URI registered on the
 * Entra app (platform type "Web", so the client secret is accepted).
 *
 * See docs/architecture/integrations/msgraph.md.
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
  // before the provider redirect; reject a forged callback before token
  // exchange so an attacker's token can't be bound to the victim.
  const cookieStore = await cookies();
  const cookieNonce = cookieStore.get(CONNECTOR_OAUTH_STATE_COOKIE)?.value;
  if (!verifyConnectorState({ stateNonce: nonce, cookieNonce })) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "invalid_state" }), request.url),
    );
  }

  try {
    const origin = new URL(request.url).origin;
    const redirectUri = `${origin}/api/auth/callback/msgraph`;

    const tokenRes = await fetch(MSGRAPH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: MSGRAPH_CLIENT_ID,
        client_secret: MSGRAPH_CLIENT_SECRET,
        redirect_uri: redirectUri,
        // Same set the authorize URL asked for - the two are built from one
        // helper so an added Graph permission can't land on only one side.
        scope: msGraphScopes().join(" "),
      }),
    });

    if (!tokenRes.ok) {
      console.error("[msgraph] token exchange failed:", await tokenRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "token_exchange_failed" }), request.url),
      );
    }

    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    // Both halves are required. Graph rotates the refresh token on every use,
    // so storing an access token alone yields a connector that works for one
    // hour and then fails permanently.
    if (!tokens.access_token || !tokens.refresh_token) {
      console.error("[msgraph] incomplete token response (access_token + refresh_token required)");
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "no_access_token" }), request.url),
      );
    }

    const expiresInMs = Math.max(0, (tokens.expires_in ?? 3600) * 1000);
    const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

    // Tenant id + connected address come from the id_token claims. Absent when
    // the tenant did not grant `openid`; both are display/routing metadata, so
    // the connect succeeds without them rather than guessing a value.
    const { tenantId, email: connectedEmail } = decodeMsGraphIdToken(tokens.id_token);

    // Get JWT from cookie to authenticate with Express backend
    const accessToken = cookieStore.get("access_token")?.value;
    if (!accessToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const storeRes = await fetch(
      `${API_URL}/api/connectors/msgraph/store-credentials`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          // Anything added to this tuple must also be handled by
          // `packMsGraphTokens` (packages/api/src/msgraph/token.ts): the
          // refresh rewrites the whole envelope, so an unhandled field is
          // erased at the first rotation rather than merely ignored.
          msgraphTokens: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt,
            ...(tenantId ? { tenantId } : {}),
          },
          email: connectedEmail,
          // Reconnect a workspace-owned instance re-points the existing row;
          // otherwise connect / add-another. Mutually exclusive.
          ...(instanceId
            ? { instanceId }
            : { createNew, label: createNew ? connectedEmail : undefined }),
        }),
      },
    );

    if (!storeRes.ok) {
      console.error("[msgraph] store credentials failed:", await storeRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "store_failed" }), request.url),
      );
    }

    // Thread the minted/reconnected instance UUID back to the connectors
    // page - the auto-expose must act on THIS instance, and a bare slug is
    // ambiguous once the provider has a second account.
    const stored = (await storeRes.json().catch(() => ({}))) as {
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
