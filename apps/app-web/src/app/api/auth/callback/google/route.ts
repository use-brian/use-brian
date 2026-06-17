import { NextResponse } from "next/server";
import {
  accessTokenCookie,
  refreshTokenCookie,
  userCookie,
  appendLegacyHostOnlyClears,
} from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

/** Allowlisted return-to / next-path prefixes within this app. */
const ALLOWED_NEXT_PREFIXES = ["/w", "/teams", "/desktop"];

function isAllowedNext(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  return ALLOWED_NEXT_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`),
  );
}

export async function GET(request: Request) {
  // Defense in depth: in production, only sidan.ai writes the shared
  // `.sidan.ai` auth cookies. The login page already redirects away
  // before any OAuth flow lands here, so this branch is dead in prod —
  // but if something does bounce here (stale bookmark, stray
  // redirect_uri), we don't write cookies; we send the user to the
  // primary's /login instead.
  const primary = primaryAuthUrl();
  if (primary) {
    return NextResponse.redirect(new URL("/login", primary));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const stateRaw = url.searchParams.get("state");

  if (error || !code) {
    return NextResponse.redirect(new URL("/login?error=oauth_failed", request.url));
  }

  const parsedState = parseState(stateRaw);

  try {
    const origin = new URL(request.url).origin;
    const redirectUri = `${origin}/api/auth/callback/google`;

    // Exchange Google authorization code for tokens.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      console.error("Google token exchange failed:", await tokenRes.text());
      return NextResponse.redirect(new URL("/login?error=token_exchange", request.url));
    }

    const tokenData = (await tokenRes.json()) as { id_token?: string };
    if (!tokenData.id_token) {
      return NextResponse.redirect(new URL("/login?error=no_id_token", request.url));
    }

    // Backend creates or finds the user and returns app JWTs. Same endpoint
    // as apps/web — distribution-web users are sidanclaw users.
    const authRes = await fetch(`${API_URL}/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken: tokenData.id_token,
        ...(parsedState.timezone ? { timezone: parsedState.timezone } : {}),
      }),
    });

    if (!authRes.ok) {
      console.error("Backend auth failed:", await authRes.text());
      return NextResponse.redirect(new URL("/login?error=auth_failed", request.url));
    }

    const authData = (await authRes.json()) as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; name: string; email: string };
      isNew?: boolean;
    };

    const nextPath = parsedState.nextPath && isAllowedNext(parsedState.nextPath)
      ? parsedState.nextPath
      : undefined;

    // Default landing: root, which resolves into the workspace picker or a
    // single-workspace redirect in src/app/page.tsx.
    const returnTo = nextPath ?? "/";

    const response = NextResponse.redirect(new URL(returnTo, request.url));
    response.cookies.set(accessTokenCookie(authData.accessToken));
    response.cookies.set(refreshTokenCookie(authData.refreshToken));
    response.cookies.set(
      userCookie(
        JSON.stringify({
          id: authData.user.id,
          name: authData.user.name,
          email: authData.user.email,
        }),
      ),
    );
    // Expire any pre-migration host-only twins so the next request only
    // carries the domain-scoped cookies we just set. Appends raw
    // Set-Cookie headers instead of `cookies.set()` so the framework's
    // name-keyed cookie map doesn't clobber the fresh domain-scoped
    // tokens. See `docs/architecture/platform/auth.md` → "Duplicate
    // cookies after the .sidan.ai migration".
    appendLegacyHostOnlyClears(response);
    return response;
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(new URL("/login?error=unexpected", request.url));
  }
}

function parseState(raw: string | null): { timezone?: string; nextPath?: string } {
  if (!raw) return {};
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const json =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { timezone?: unknown; nextPath?: unknown };
    const tz =
      typeof parsed.timezone === "string" &&
      parsed.timezone.length > 0 &&
      parsed.timezone.length < 80
        ? parsed.timezone
        : undefined;
    const nextPath =
      typeof parsed.nextPath === "string" && parsed.nextPath.length > 0 && parsed.nextPath.length < 512
        ? parsed.nextPath
        : undefined;
    return { timezone: tz, nextPath };
  } catch {
    return {};
  }
}
