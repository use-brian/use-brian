import { NextResponse } from "next/server";
import { portalConfig } from "@/lib/config";

export function GET() { return NextResponse.redirect(new URL(portalConfig().appOrigin)); }
