import { NextResponse } from "next/server";
import { portalConfig } from "@/lib/config";

export function GET() {
  try {
    portalConfig();
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[outpost-auth/health] invalid configuration", error);
    return NextResponse.json({ status: "error", error: "invalid_configuration" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
