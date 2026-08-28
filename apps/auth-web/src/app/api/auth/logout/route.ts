import { NextResponse } from "next/server";
import { clearAuthCookies } from "@/lib/cookies";
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
  const response = form ? NextResponse.redirect(next ?? new URL("/login", config.portalOrigin), 303) : NextResponse.json({ ok: true });
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
