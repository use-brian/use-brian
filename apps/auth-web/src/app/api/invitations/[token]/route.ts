import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const backend = await fetch(backendUrl(`/api/invitations/${encodeURIComponent(token)}`), { cache: "no-store" });
    return new NextResponse(await backend.text(), { status: backend.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "unavailable" }, { status: 502 }); }
}
