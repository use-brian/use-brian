import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { parseLastCookie } from "@/lib/cookies";
import { portalConfig } from "@/lib/config";

export async function POST(request: Request) {
  const token = parseLastCookie(request.headers.get("cookie") ?? "", "access_token");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.text();
  try {
    const backend = await fetch(backendUrl("/api/invitations/accept"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body });
    const payload = await backend.json().catch(() => ({})) as Record<string, unknown>;
    return NextResponse.json({ ...payload, ...(backend.ok ? { appUrl: portalConfig().appOrigin } : {}) }, { status: backend.status, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "unavailable" }, { status: 502 }); }
}
