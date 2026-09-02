import { resolveRuntimePublicConfig } from "@/lib/runtime-public-config";
// Next.js Route Handler — GET /api/desktop-config
//
// Deployment self-description for the desktop shell. The Electron app lets a
// user point it at a self-hosted brain by typing ONE address (the app URL);
// this endpoint is how that deployment then declares where its own backend
// lives, instead of the shell guessing from the hostname.
//
// The shell needs the value BEFORE it commits to a target — the
// pre-switch `/health` probe in main.ts `run-local` validates the brain before
// persisting and relaunching — which rules out anything only readable after
// the page has loaded in the window.
//
// We report the browser-facing runtime origins, not the server-side
// `API_URL`: on a reverse-proxied self-host those differ (`API_URL` is often an
// internal `localhost:4000` hop, while the browser dials the public hostname),
// and the shell dials the API the same way the browser does.
//
// Public and unauthenticated by necessity — the shell calls it before any
// session exists. It discloses nothing secret: every value here is already
// shipped inside the public client bundle.
//
// Older self-hosts predate this route and 404; the shell falls back to
// `deriveLocalApiUrl` there, so this is additive.
//
// Spec: docs/architecture/features/app-desktop.md → "Dual target"
// Component-map tag: [COMP:app-web/desktop-config-route].

import { NextResponse } from "next/server";

export async function GET() {
  const config = resolveRuntimePublicConfig(process.env);
  return NextResponse.json(
    {
      ...config,
      docSyncUrl: config.docSyncUrl || "",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
