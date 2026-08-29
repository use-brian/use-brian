import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { clearAuthCookies, installSession, parseLastCookie, type AuthData } from "@/lib/cookies";
import { portalConfig } from "@/lib/config";
import { dictionaryFor, normalizeLocale, type Locale } from "@/lib/i18n/server";
import { loginUrl, safeReturnUrl } from "@/lib/origins";

const rejected = (status: number) => status === 400 || status === 401 || status === 403;
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function normalizedRetry(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(parsed) ? Math.min(4, Math.max(0, parsed)) : 0;
}

function retryResponse(requestUrl: string, next: URL | null, retry: number, locale: Locale) {
  const config = portalConfig();
  const t = dictionaryFor(locale).refresh;
  const self = new URL("/api/auth/refresh-and-return", config.portalOrigin);
  if (next) self.searchParams.set("next", next.toString());
  self.searchParams.set("retry", String(retry + 1));
  const manual = new URL(self); manual.searchParams.delete("retry");
  const auto = retry < 4;
  return new NextResponse(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${auto ? `<meta http-equiv="refresh" content="2;url=${escape(self.toString())}">` : ""}<title>${escape(t.title)}</title></head><body><main><h1>${escape(t.title)}</h1><p>${escape(auto ? t.body : t.manual)}</p><a href="${escape(manual.toString())}">${escape(t.retry)}</a></main></body></html>`, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const config = portalConfig();
  const url = new URL(request.url);
  const next = safeReturnUrl(url.searchParams.get("next"), config);
  const cookieHeader = request.headers.get("cookie") ?? "";
  const token = parseLastCookie(cookieHeader, "refresh_token");
  if (!token) {
    const response = NextResponse.redirect(loginUrl(config, next));
    clearAuthCookies(response);
    return response;
  }
  try {
    const backend = await fetch(backendUrl("/auth/refresh"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: token }) });
    if (backend.ok) {
      const data = await backend.json() as AuthData;
      const response = NextResponse.redirect(next ?? new URL(config.appOrigin));
      installSession(response, data);
      return response;
    }
    if (rejected(backend.status)) {
      const response = NextResponse.redirect(loginUrl(config, next));
      clearAuthCookies(response);
      return response;
    }
  } catch { /* transient below */ }
  return retryResponse(request.url, next, normalizedRetry(url.searchParams.get("retry")), normalizeLocale(parseLastCookie(cookieHeader, "locale")));
}
