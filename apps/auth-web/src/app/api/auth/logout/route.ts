import { NextResponse } from "next/server";
import { clearAuthCookies, parseLastCookie } from "@/lib/cookies";
import { backendUrl } from "@/lib/backend";
import { portalConfig } from "@/lib/config";
import { safeReturnUrl } from "@/lib/origins";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const config = portalConfig();
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if ((origin && origin !== config.portalOrigin) || fetchSite === "cross-site") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const form = contentType.includes("form") ? await request.formData().catch(() => null) : null;
  const next = typeof form?.get("next") === "string" ? safeReturnUrl(String(form.get("next")), config) : null;
  // The portal owns the refresh cookie, so it must also end the server-side
  // session. Client-side access-token revocation is only best effort and can
  // fail once the access token expires. Cookie deletion alone lets a retained
  // token (or an in-flight refresh response) restore a usable session.
  const token = parseLastCookie(request.headers.get("cookie") ?? "", "refresh_token");
  if (token) {
    try {
      const backend = await fetch(backendUrl("/auth/logout"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: token }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      // An invalid/expired refresh token cannot restore a session either.
      if (!backend.ok && backend.status !== 401) throw new Error("Logout unavailable");
    } catch {
      // Keep the credential for a retry; never claim success while the backend
      // session may still be live. Do not bounce into the app's refresh guard.
      const retry = new URL("/logout", config.portalOrigin);
      retry.searchParams.set("error", "unavailable");
      if (next) retry.searchParams.set("next", next.toString());
      return form
        ? NextResponse.redirect(retry, { status: 303, headers: { "Cache-Control": "no-store" } })
        : NextResponse.json({ error: "logout_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
  const response = form ? NextResponse.redirect(next ?? new URL("/login", config.portalOrigin), 303) : NextResponse.json({ ok: true });
  response.headers.set("Cache-Control", "no-store");
  clearAuthCookies(response);
  return response;
}

export function GET(request: Request) {
  const config = portalConfig();
  const next = safeReturnUrl(new URL(request.url).searchParams.get("next"), config);
  const confirmation = new URL("/logout", config.portalOrigin);
  if (next) confirmation.searchParams.set("next", next.toString());
  return NextResponse.redirect(confirmation);
}
