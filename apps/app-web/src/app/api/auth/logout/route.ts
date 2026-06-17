// Next.js Route Handler — /api/auth/logout (app-web)
//
// DEV sign-out. Clears the host-only `localhost` auth cookies server-side
// (the `refresh_token` is httpOnly, so browser JS can't delete it) and
// returns 200 so the client can navigate to /login.
//
// In PRODUCTION this sub-app must NOT write the shared `.sidan.ai` auth
// cookies — the design rule is "sidan.ai → sub-app, not the other way
// round". There the client redirects the browser to
// `${primary}/api/auth/logout?next=…` (the primary clears the domain-scoped
// cookies and bounces back), so this route is never the one that clears
// them; it returns 410 if hit. Mirrors the same guard in
// `apps/app-web/src/app/api/auth/refresh/route.ts`.
//
// [COMP:app-web/auth-logout]

import { NextResponse } from "next/server";
import { applyClearedCookies } from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";

export async function POST() {
  if (primaryAuthUrl()) {
    return NextResponse.json(
      {
        error: "logout_disabled_on_subapp",
        message:
          "Sign out happens at the primary's /api/auth/logout?next=… endpoint, not this sub-app.",
      },
      { status: 410 },
    );
  }
  const res = NextResponse.json({ ok: true });
  applyClearedCookies(res);
  return res;
}
