import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { clearAuthCookies, installSession, parseLastCookie, type AuthData } from "@/lib/cookies";
import { portalConfig } from "@/lib/config";

type RefreshResult = { kind: "ok"; data: AuthData } | { kind: "rejected" } | { kind: "transient" };

const authRejected = (status: number) => status === 400 || status === 401 || status === 403;

async function refreshSession(cookieHeader: string): Promise<RefreshResult> {
  const refreshToken = parseLastCookie(cookieHeader, "refresh_token");
  if (!refreshToken) return { kind: "rejected" };
  try {
    const response = await fetch(backendUrl("/auth/refresh"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (response.ok) return { kind: "ok", data: await response.json() as AuthData };
    return { kind: authRejected(response.status) ? "rejected" : "transient" };
  } catch {
    return { kind: "transient" };
  }
}

function refreshFailure(result: Exclude<RefreshResult, { kind: "ok" }>) {
  const response = NextResponse.json(
    { error: result.kind === "rejected" ? "Unauthorized" : "refresh_transient" },
    { status: result.kind === "rejected" ? 401 : 503, headers: { "Cache-Control": "no-store" } },
  );
  if (result.kind === "rejected") clearAuthCookies(response);
  return response;
}

export async function POST(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  let token = parseLastCookie(cookieHeader, "access_token");
  let refreshed: AuthData | null = null;
  const body = await request.text();

  if (!token) {
    const result = await refreshSession(cookieHeader);
    if (result.kind !== "ok") return refreshFailure(result);
    refreshed = result.data;
    token = result.data.accessToken;
  }

  try {
    let backend = await fetch(backendUrl("/api/invitations/accept"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body });
    if (backend.status === 401 && !refreshed) {
      const result = await refreshSession(cookieHeader);
      if (result.kind !== "ok") return refreshFailure(result);
      refreshed = result.data;
      backend = await fetch(backendUrl("/api/invitations/accept"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${result.data.accessToken}` }, body });
    }
    const payload = await backend.json().catch(() => ({})) as Record<string, unknown>;
    const response = NextResponse.json({ ...payload, ...(backend.ok ? { appUrl: portalConfig().appOrigin } : {}) }, { status: backend.status, headers: { "Cache-Control": "no-store" } });
    if (refreshed) installSession(response, refreshed);
    return response;
  } catch {
    const response = NextResponse.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
    if (refreshed) installSession(response, refreshed);
    return response;
  }
}
