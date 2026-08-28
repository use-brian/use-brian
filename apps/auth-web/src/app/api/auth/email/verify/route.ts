import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { installSession, type AuthData } from "@/lib/cookies";
import { sessionRedirect } from "@/lib/session";
import { portalConfig } from "@/lib/config";
import { safeReturnUrl } from "@/lib/origins";

export function GET(request: Request) {
  const source = new URL(request.url);
  const target = new URL("/login/verify", portalConfig().portalOrigin);
  target.search = source.search;
  return NextResponse.redirect(target);
}

export async function POST(request: Request) {
  if (!portalConfig().emailEnabled) return NextResponse.json({ error: "email_signin_unavailable" }, { status: 404 });
  const form = await request.formData().catch(() => null);
  const token = typeof form?.get("token") === "string" ? String(form.get("token")) : "";
  const config = portalConfig();
  const next = typeof form?.get("next") === "string" ? safeReturnUrl(String(form.get("next")), config) : null;
  const failure = (error: string) => {
    const target = new URL("/login", config.portalOrigin);
    target.searchParams.set("error", error);
    if (next) target.searchParams.set("next", next.toString());
    return NextResponse.redirect(target, 303);
  };
  if (!token) return failure("missing_token");
  try {
    const backend = await fetch(backendUrl("/auth/email/verify"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (backend.status === 401) return failure("link_expired");
    if (backend.status === 403) return failure("enrollment_required");
    if (!backend.ok) return failure("auth_failed");
    const data = await backend.json() as AuthData;
    const response = NextResponse.redirect(sessionRedirect(data), 303);
    installSession(response, data);
    return response;
  } catch {
    return failure("unexpected");
  }
}
