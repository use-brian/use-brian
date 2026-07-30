import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  CONNECTOR_OAUTH_STATE_COOKIE,
  parseConnectorState,
  verifyConnectorState,
} from "@/lib/connector-oauth-state";
import {
  buildShopifyTokenExchangeBody,
  classifyShopifyTokens,
  verifyShopifyCallbackHmac,
  type ShopifyTokenResponse,
} from "@/lib/shopify-oauth";
import { normalizeShopifyShopDomain } from "@/lib/shopify-domain";
// SERVER-side hop to the API — must be INTERNAL_API_URL, never the browser's
// NEXT_PUBLIC_API_URL. next.config inlines that one as "" in development so the
// browser goes through the /api rewrite; a Route Handler runs in Node, where a
// relative URL has no origin and fetch throws ERR_INVALID_URL. That is why the
// Shopify connect died at store-credentials on 2026-07-29 AFTER a fully
// successful consent + token exchange. In production the same var resolves to
// the PUBLIC origin, which sends app-web's own call back out through the CDN —
// the exact Cloudflare-Access-returns-HTML trap documented in
// lib/internal-api-url.ts.
import { INTERNAL_API_URL as API_URL } from "@/lib/internal-api-url";
const SHOPIFY_CLIENT_ID =
  process.env.SHOPIFY_CLIENT_ID ?? process.env.NEXT_PUBLIC_SHOPIFY_CLIENT_ID ?? "";
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET ?? "";

// Keep in sync with SHOPIFY_API_VERSION in packages/api/src/shopify/client.ts
// (roll quarterly). Only used for the best-effort identity fetch below.
const SHOPIFY_API_VERSION = "2026-04";

/**
 * Shopify OAuth callback (Notion/Fathom template + Shopify deltas).
 *
 * Deltas: the token endpoint is per-shop (`https://{shop}/admin/oauth/
 * access_token`), and Shopify signs the callback query with an `hmac` param
 * (hex HMAC-SHA256 of the sorted query, keyed by the app client secret) that
 * is verified IN ADDITION to our own `state` nonce, before any exchange.
 * The exchanged token may be expiring (access + rotating refresh + expiry —
 * public apps after 2026-04) or legacy non-expiring; both are POSTed as the
 * `shopifyTokens` tuple and the shape discriminates downstream.
 *
 * NOT REACHABLE as of 2026-07-30 — kept deliberately, do not delete. Shopify
 * connects by pasted Admin API token only, and the connectors page no longer
 * builds an authorize URL, so nothing in the product ever redirects here. This
 * route stays because the flow is correct and expensive to re-derive (the
 * `expiring: 1` exchange, the state + query-hmac double gate, and
 * rotate-persist-before-use); re-enabling means restoring the UI branch AND
 * setting `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`. It also still fails
 * closed without those secrets.
 *
 * See docs/architecture/integrations/shopify.md → "Auth model" for why the
 * OAuth path is not offered and what re-enabling requires.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? ""; // "shopify[:add]:<workspaceId>:<nonce>"
  const error = url.searchParams.get("error");
  const shopDomain = normalizeShopifyShopDomain(url.searchParams.get("shop") ?? "");

  const { connector: intent, createNew, instanceId, workspaceId, nonce } = parseConnectorState(stateRaw);
  const validIntent = intent === "shopify";

  if (error || !code || !validIntent || !shopDomain) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "consent_denied" }), request.url),
    );
  }

  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    console.error("[shopify] callback hit with no app credentials configured");
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "unexpected" }), request.url),
    );
  }

  // CSRF gate: the `state` nonce must match the companion cookie set before
  // the provider redirect; reject a forged callback before token exchange so
  // an attacker's token can't be bound to the victim.
  const cookieStore = await cookies();
  const cookieNonce = cookieStore.get(CONNECTOR_OAUTH_STATE_COOKIE)?.value;
  if (!verifyConnectorState({ stateNonce: nonce, cookieNonce })) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "invalid_state" }), request.url),
    );
  }

  // Shopify's own signature over the callback query — the second gate.
  if (!verifyShopifyCallbackHmac(url.searchParams, SHOPIFY_CLIENT_SECRET)) {
    return NextResponse.redirect(
      new URL(connectorsPath(workspaceId, { error: "invalid_state" }), request.url),
    );
  }

  try {
    const tokenRes = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        buildShopifyTokenExchangeBody({
          clientId: SHOPIFY_CLIENT_ID,
          clientSecret: SHOPIFY_CLIENT_SECRET,
          code,
        }),
      ),
    });

    if (!tokenRes.ok) {
      console.error("[shopify] token exchange failed:", await tokenRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "token_exchange_failed" }), request.url),
      );
    }

    const tokens = (await tokenRes.json()) as ShopifyTokenResponse;

    // Expiring offline token (what `expiring: 1` asks for) vs a legacy
    // non-expiring one: only the former carries refresh_token + expires_in,
    // and the resulting tuple SHAPE is what discriminates downstream.
    const classified = classifyShopifyTokens(tokens, Date.now());

    if (!classified) {
      console.error("[shopify] incomplete token response");
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "no_access_token" }), request.url),
      );
    }

    const managed = !!classified.refreshToken;
    const expiresAt = classified.expiresAt;

    // Best-effort identity fetch — confirms the token works and picks up the
    // canonical myshopify domain. Failure is non-fatal (the `shop` param is
    // already validated + canonical).
    let canonicalDomain = shopDomain;
    try {
      const shopRes = await fetch(
        `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": classified.accessToken,
          },
          body: JSON.stringify({ query: "query { shop { name myshopifyDomain } }" }),
        },
      );
      if (shopRes.ok) {
        const payload = (await shopRes.json()) as {
          data?: { shop?: { myshopifyDomain?: string } };
        };
        const reported = normalizeShopifyShopDomain(payload.data?.shop?.myshopifyDomain ?? "");
        if (reported) canonicalDomain = reported;
      }
    } catch (err) {
      console.error("[shopify] shop identity fetch failed:", err);
    }

    const accessToken = cookieStore.get("access_token")?.value;
    if (!accessToken) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const storeRes = await fetch(`${API_URL}/api/connectors/shopify/store-credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        shopifyTokens: {
          accessToken: classified.accessToken,
          ...(managed ? { refreshToken: classified.refreshToken, expiresAt } : {}),
          shopDomain: canonicalDomain,
        },
        // The shop domain plays the connectedEmail role in the Settings UI
        // ("Connected: mystore.myshopify.com").
        email: canonicalDomain,
        // Reconnect re-points the existing row; otherwise connect /
        // add-another. Mutually exclusive. Instance label = shop domain (D3).
        ...(instanceId
          ? { instanceId }
          : { createNew, label: createNew ? canonicalDomain : undefined }),
      }),
    });

    if (!storeRes.ok) {
      console.error("[shopify] store credentials failed:", await storeRes.text());
      return NextResponse.redirect(
        new URL(connectorsPath(workspaceId, { error: "store_failed" }), request.url),
      );
    }

    const stored = (await storeRes.json().catch(() => ({}))) as {
      connectorInstanceId?: string;
    };

    return NextResponse.redirect(
      new URL(
        connectorsPath(workspaceId, {
          connected: "shopify",
          instance: stored.connectorInstanceId,
        }),
        request.url,
      ),
    );
  } catch (err) {
    console.error("[shopify] callback error:", err);
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
