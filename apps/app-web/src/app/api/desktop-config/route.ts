// Next.js Route Handler — GET /api/desktop-config
//
// Deployment self-description for the desktop shell. The Electron app lets a
// user point it at a self-hosted brain by typing ONE address (the app URL);
// this endpoint is how that deployment then declares where its own backend
// lives, instead of the shell guessing from the hostname.
//
// Why an endpoint and not "read it from the page": `NEXT_PUBLIC_*` is inlined
// by Next as a bare string literal inside webpack module closures at build
// time. It is not on `window` and `process.env.NEXT_PUBLIC_API_URL` does not
// survive into the client bundle, so nothing outside the bundle can read it.
// The shell also needs the value BEFORE it commits to a target — the
// pre-switch `/health` probe in main.ts `run-local` validates the brain before
// persisting and relaunching — which rules out anything only readable after
// the page has loaded in the window.
//
// We report the BROWSER-facing origins (`NEXT_PUBLIC_*`), not the server-side
// `API_URL`: on a reverse-proxied self-host those differ (`API_URL` is often an
// internal `localhost:4000` hop, while the browser dials the public hostname),
// and the shell dials the API the same way the browser does. Being read inside
// a route handler, the `NEXT_PUBLIC_*` reads are inlined at BUILD time, so they
// report what the client actually calls even when those vars are absent from
// the runtime environment (the built self-host case).
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
import { isOssEdition } from "@/lib/edition";

// The browser-facing API origin. `NEXT_PUBLIC_API_URL` is the one the client
// bundle uses; `API_URL` is the server-side hop and is only a last resort (it
// may be an internal address, but it beats defaulting to a dev port on a
// deployment that set only the server var).
const API_URL =
  process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || "http://localhost:4000";

/** The doc-sync WebSocket origin, when this deployment pins one explicitly. */
const DOC_SYNC_URL = process.env.NEXT_PUBLIC_DOC_SYNC_URL || null;

export async function GET() {
  return NextResponse.json(
    {
      // The shell reads `apiUrl` to pair its target; the rest is discovery
      // context (the shell surfaces `edition` to explain a brain that is
      // reachable but cannot mint a local-owner session).
      apiUrl: API_URL,
      docSyncUrl: DOC_SYNC_URL,
      edition: isOssEdition() ? "oss" : "hosted",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
