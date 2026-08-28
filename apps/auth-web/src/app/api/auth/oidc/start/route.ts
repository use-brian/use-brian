import { NextResponse } from "next/server";
import { portalConfig } from "@/lib/config";
import { safeReturnUrl } from "@/lib/origins";
import { authorizationUrl, discoverOidc, pkceChallenge } from "@/lib/oidc";
import {
  OIDC_TRANSACTION_COOKIE,
  OIDC_TRANSACTION_MAX_AGE,
  randomBase64Url,
  serializeOidcTransaction,
} from "@/lib/oidc-transaction";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const config = portalConfig();
  if (!config.oidcEnabled || !config.oidc) {
    return NextResponse.json({ error: "oidc_signin_unavailable" }, { status: 404 });
  }
  const requestUrl = new URL(request.url);
  const next = safeReturnUrl(requestUrl.searchParams.get("next"), config)?.toString();
  const transaction = {
    state: randomBase64Url(),
    nonce: randomBase64Url(),
    verifier: randomBase64Url(48),
    createdAt: Date.now(),
    ...(next ? { next } : {}),
  };
  try {
    const metadata = await discoverOidc(config);
    const response = NextResponse.redirect(authorizationUrl(metadata, config, {
      state: transaction.state,
      nonce: transaction.nonce,
      challenge: pkceChallenge(transaction.verifier),
    }));
    response.cookies.set({
      name: OIDC_TRANSACTION_COOKIE,
      value: serializeOidcTransaction(transaction, config.oidc.bridgeSecret),
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: OIDC_TRANSACTION_MAX_AGE,
    });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=oidc_failed", config.portalOrigin));
  }
}
