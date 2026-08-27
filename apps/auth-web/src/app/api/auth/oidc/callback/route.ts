import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { portalConfig } from "@/lib/config";
import { installSession, parseLastCookie, type AuthData } from "@/lib/cookies";
import { loginUrl } from "@/lib/origins";
import { discoverOidc, exchangeOidcCode, verifyOidcIdentity } from "@/lib/oidc";
import {
  equalState,
  OIDC_TRANSACTION_COOKIE,
  parseOidcTransaction,
} from "@/lib/oidc-transaction";
import { sessionRedirect } from "@/lib/session";

export const runtime = "nodejs";

function clearTransaction(response: NextResponse): NextResponse {
  response.cookies.set({ name: OIDC_TRANSACTION_COOKIE, value: "", path: "/", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  const config = portalConfig();
  if (!config.oidcEnabled || !config.oidc) {
    return NextResponse.json({ error: "oidc_signin_unavailable" }, { status: 404 });
  }
  const requestUrl = new URL(request.url);
  const rawTransaction = parseLastCookie(request.headers.get("cookie") ?? "", OIDC_TRANSACTION_COOKIE);
  const transaction = parseOidcTransaction(rawTransaction, config.oidc.bridgeSecret);
  const fail = (error: string) => clearTransaction(NextResponse.redirect(
    loginUrl(config, transaction?.next ? new URL(transaction.next) : null, error),
  ));
  const state = requestUrl.searchParams.get("state");
  if (!transaction || !state || !equalState(state, transaction.state)) return fail("oidc_failed");
  if (requestUrl.searchParams.has("error")) return fail("oidc_failed");
  const code = requestUrl.searchParams.get("code");
  if (!code || code.length > 2048) return fail("oidc_failed");

  let stage = "discovery";
  try {
    const metadata = await discoverOidc(config);
    stage = "token_exchange";
    const idToken = await exchangeOidcCode(metadata, config, code, transaction.verifier);
    stage = "id_token_verification";
    const identity = await verifyOidcIdentity(idToken, metadata, config, transaction.nonce);
    stage = "brian_session_bridge";
    const backend = await fetch(backendUrl("/auth/oidc/session"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Outpost-Auth-Bridge": config.oidc.bridgeSecret,
      },
      body: JSON.stringify(identity),
    });
    if (backend.status === 403) return fail("enrollment_required");
    if (!backend.ok) return fail("oidc_failed");
    const data = await backend.json() as AuthData;
    data.nextPath = transaction.next;
    const response = clearTransaction(NextResponse.redirect(sessionRedirect(data)));
    installSession(response, data);
    return response;
  } catch (error) {
    const safeCode = oidcDiagnosticCode(error);
    console.warn(`[outpost-auth/oidc] ${stage} failed${safeCode ? ` (${safeCode})` : ""}`);
    return fail("oidc_failed");
  }
}

function oidcDiagnosticCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = "code" in error && typeof error.code === "string" && /^ERR_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : null;
  if (code) return code;
  const fixed = new Map([
    ["OIDC discovery failed", "discovery_rejected"],
    ["OIDC issuer mismatch", "issuer_mismatch"],
    ["OIDC token exchange failed", "token_rejected"],
    ["OIDC ID token missing", "id_token_missing"],
    ["OIDC JWKS fetch failed", "jwks_rejected"],
    ["OIDC nonce mismatch", "nonce_mismatch"],
    ["OIDC authorized party mismatch", "authorized_party_mismatch"],
    ["OIDC verified email required", "verified_email_missing"],
    ["OIDC email required", "email_missing"],
    ["OIDC subject required", "subject_missing"],
    ["OIDC endpoint origin mismatch", "endpoint_origin_rejected"],
    ["OIDC response too large", "response_too_large"],
    ["Unsupported OIDC client authentication method", "client_auth_unsupported"],
  ]);
  return fixed.get(error.message) ?? null;
}
