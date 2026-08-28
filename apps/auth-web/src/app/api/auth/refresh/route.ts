import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { clearAuthCookies, installSession, parseLastCookie, type AuthData } from "@/lib/cookies";

const authRejected = (status: number) => status === 400 || status === 401 || status === 403;

export async function POST(request: Request) {
  const token = parseLastCookie(request.headers.get("cookie") ?? "", "refresh_token");
  if (!token) {
    const response = NextResponse.json({ error: "no_refresh_token" }, { status: 401 });
    clearAuthCookies(response);
    return response;
  }
  try {
    const backend = await fetch(backendUrl("/auth/refresh"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: token }) });
    if (!backend.ok) {
      if (!authRejected(backend.status)) return NextResponse.json({ error: "refresh_transient" }, { status: 503 });
      const response = NextResponse.json({ error: "refresh_rejected" }, { status: 401 });
      clearAuthCookies(response);
      return response;
    }
    const data = await backend.json() as AuthData;
    const response = NextResponse.json({ accessToken: data.accessToken });
    installSession(response, data);
    return response;
  } catch {
    return NextResponse.json({ error: "refresh_transient" }, { status: 503 });
  }
}
