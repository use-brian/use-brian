// Next.js Route Handler — GET /api/auth/local-session
//
// The OSS single-player front door. Calls the backend `/auth/local-session`
// (mounted only on a local, oss-edition API — see
// packages/api/src/routes/local-session.ts), installs the returned token pair
// as the standard auth cookies, and bounces to the app root as the local
// owner. From there the session is indistinguishable from a real login.
//
// This is NOT `dev-login`: that route signs you in as a throwaway "Local Dev"
// user for debugging the hosted edition locally. This one is the product — a
// neutral owner identity, no email surfaced.
//
// Dead outside an oss deploy: 404s when `primaryAuthUrl()` resolves (a sub-app
// deploy where the primary owns auth) or when this is not the oss edition. The
// backend route is itself gated on oss + not-cloud, so a token can never be
// minted in the cloud. We do NOT gate on NODE_ENV: a built self-host runs
// `next start` (NODE_ENV="production"), so the edition + primary checks are the
// real gate. `isOssEdition()` resolves the SERVER-side `USEBRIAN_EDITION` at
// runtime as well as the build-inlined public var, so a prebuilt tree that was
// compiled without the edition set still opens here when the deploy's env says
// oss. Redirects use APP_URL because behind a reverse proxy request.url
// resolves to the bound localhost address.
//
// Accepts an optional `?next=<path>` (same-origin absolute paths only) so a
// signed-out deep link routed here by the proxy resumes where it was headed.
//
// Component-map tag: [COMP:app-web/local-session-route].

import { NextResponse } from "next/server";
import {
  accessTokenCookie,
  refreshTokenCookie,
  userCookie,
  appendLegacyHostOnlyClears,
} from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";
import { isOssEdition } from "@/lib/edition";
import { sanitizeNext } from "@/lib/oss-entry";

// Same resolution as the app-web OAuth callback + refresh bridges:
// server-side `API_URL`, defaulting to the local dev API.
const API_URL = process.env.API_URL ?? "http://localhost:4000";

export async function GET(request: Request) {
  // Behind a reverse proxy (Cloudflare Tunnel) Next resolves request.url to the
  // bound address (localhost:PORT), so absolute redirects must be built from the
  // configured public origin instead.
  const appOrigin = process.env.APP_URL ?? request.url;
  const nextPath = sanitizeNext(new URL(request.url).searchParams.get("next"));

  if (primaryAuthUrl() !== null || !isOssEdition()) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const backendRes = await fetch(new URL(`${API_URL}/auth/local-session`), {
      method: "POST",
    });
    if (!backendRes.ok) {
      console.error("[/api/auth/local-session] backend rejected:", backendRes.status);
      return NextResponse.redirect(
        new URL("/login?error=local_session_failed", appOrigin),
      );
    }

    const data = (await backendRes.json()) as {
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string | null;
        name: string | null;
      };
    };

    // Land on `next` (default `/`), which resolves into the single-workspace
    // redirect in src/app/page.tsx — the same destination the OAuth callback
    // uses.
    const response = NextResponse.redirect(new URL(nextPath, appOrigin));
    response.cookies.set(accessTokenCookie(data.accessToken));
    response.cookies.set(refreshTokenCookie(data.refreshToken));
    response.cookies.set(
      userCookie(
        JSON.stringify({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
        }),
      ),
    );
    appendLegacyHostOnlyClears(response);

    return response;
  } catch (err) {
    console.error("[/api/auth/local-session] error:", err);
    return NextResponse.redirect(
      new URL("/login?error=local_session_failed", appOrigin),
    );
  }
}
