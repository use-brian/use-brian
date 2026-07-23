import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CONNECTOR_OAUTH_STATE_COOKIE,
  parseConnectorState,
  verifyConnectorState,
} from "@/lib/connector-oauth-state";
import { parseDesktopConnectorState, buildLoopbackForwardUrl } from "@/lib/connector-oauth-desktop";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID ?? "";
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET ?? "";

/**
 * Notion OAuth callback for the Notion connector — app-web copy.
 *
 * Ported from `apps/web/src/app/api/auth/callback/notion/route.ts`
 * (app consolidation §9 #5). Same pattern: Notion-specific token exchange
 * (Basic Auth, JSON body, long-lived access token), then POST to the Express
 * backend, then redirect back to Studio -> Connectors.
 *
 * app-web delta: the connectors page threads the active workspace id into
 * `state` (`notion:<workspaceId>` or `notion:add:<workspaceId>`). This callback
 * parses the intent + workspace id and redirects to the workspace-scoped route.
 *
 * INFRA (degraded): requires `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` and a
 * `app.usebrian.ai/...` redirect_uri allowlisted in the Notion OAuth app.
 * Doc-web does not set `NEXT_PUBLIC_NOTION_CLIENT_ID` yet, so the connect
 * button can't reach this callback until that lands.
 *
 * See docs/architecture/integrations/notion.md.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? ""; // "notion[:add]:<workspaceId>:<nonce>"
  const error = url.searchParams.get("error");

  // Desktop (Electron) path — forward the code to the shell's loopback; it does
  // the exchange + store with its own session. See the google-connector callback
  // and docs/plans/desktop-connector-oauth-return.md for why.
  const desktopState = parseDesktopConnectorState(stateRaw);
  if (desktopState) {
    const forward = buildLoopbackForwardUrl(desktopState, { code, error });
    if (!forward) {
      return NextResponse.redirect(
        new URL(connectorsPath(desktopState.workspaceId, { error: "invalid_state" }), request.url),
      );
    }
    return NextResponse.redirect(forward);
  }

  const { connector: intent, createNew, instanceId, workspaceId, nonce } = parseConnectorState(stateRaw);
  const validIntent = intent === "notion";

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
    const redirectUri = `${origin}/api/auth/callback/notion`;

    // Notion uses HTTP Basic Auth for token exchange
    const credentials = Buffer.from(
      `${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`,
    ).toString("base64");

    const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      console.error("[notion] token exchange failed:", await tokenRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "token_exchange_failed" }), request.url),
      );
    }

    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      workspace_id?: string;
      workspace_name?: string;
      bot_id?: string;
    };

    if (!tokens.access_token) {
      console.error("[notion] no access_token returned");
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "no_access_token" }), request.url),
      );
    }

    // Get JWT from cookie to authenticate with Express backend
    const accessToken = cookieStore.get("access_token")?.value;
    if (!accessToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    // Send Notion access token to Express backend to store encrypted
    const storeRes = await fetch(
      `${API_URL}/api/connectors/notion/store-credentials`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          accessToken: tokens.access_token,
          // Reconnect a workspace-owned instance re-points the existing row;
          // otherwise connect / add-another. Mutually exclusive.
          ...(instanceId
            ? { instanceId }
            : { createNew, label: createNew ? tokens.workspace_name : undefined }),
        }),
      },
    );

    if (!storeRes.ok) {
      console.error("[notion] store credentials failed:", await storeRes.text());
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
          connected: "notion",
          instance: stored.connectorInstanceId,
        }),
        request.url,
      ),
    );
  } catch (err) {
    console.error("[notion] callback error:", err);
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
