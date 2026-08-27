import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { portalConfig } from "@/lib/config";

export function trustedClientIp(request: Request, trustProxyHeaders: boolean): string | null {
  if (!trustProxyHeaders) return null;
  const direct = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip");
  if (direct?.trim()) return direct.trim();
  const chain = request.headers.get("x-forwarded-for")?.split(",").map((value) => value.trim()).filter(Boolean);
  return chain?.at(-1) ?? null;
}

export async function POST(request: Request) {
  if (!portalConfig().emailEnabled) return NextResponse.json({ error: "email_signin_unavailable" }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ ok: true });
  try {
    const clientIp = trustedClientIp(request, portalConfig().trustProxyHeaders);
    await fetch(backendUrl("/auth/email/request-link"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
        ...(request.headers.get("user-agent") ? { "User-Agent": request.headers.get("user-agent")! } : {}),
        ...(request.headers.get("accept-language") ? { "Accept-Language": request.headers.get("accept-language")! } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("[outpost-auth/request-link] backend unavailable", error);
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
