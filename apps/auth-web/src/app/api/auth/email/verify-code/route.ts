import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { installSession, type AuthData } from "@/lib/cookies";
import { sessionRedirect } from "@/lib/session";
import { portalConfig } from "@/lib/config";

export async function POST(request: Request) {
  if (!portalConfig().emailEnabled) return NextResponse.json({ error: "email_signin_unavailable" }, { status: 404 });
  const body = await request.json().catch(() => null) as { email?: unknown; code?: unknown; timezone?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!email || !/^\d{6}$/.test(code)) return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  let backend: Response;
  try {
    backend = await fetch(backendUrl("/auth/email/verify-code"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code, timezone: body?.timezone }) });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
  if (backend.status === 429) return NextResponse.json({ error: "too_many_attempts" }, { status: 429 });
  if (backend.status === 400 || backend.status === 401) return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  if (backend.status === 403) return NextResponse.json({ error: "enrollment_required" }, { status: 403 });
  if (!backend.ok) return NextResponse.json({ error: "auth_failed" }, { status: 500 });
  const data = await backend.json() as AuthData;
  const response = NextResponse.json({ ok: true, redirect: sessionRedirect(data).toString() });
  installSession(response, data);
  return response;
}
