import { NextResponse } from "next/server";
import { parseLastCookie } from "@/lib/auth-cookies";
import { loopbackRedirectBase } from "@/lib/desktop-loopback";

/**
 * Desktop (Electron) sign-in bridge — the browser side of the RFC 8252 + PKCE
 * handoff.
 *
 * The Electron shell opens the system browser at
 * `${AUTHED_APP_URL}/desktop/auth?challenge=<S256>&redirect=<loopback>&state=<nonce>`.
 * Here, for an authenticated browser session, we mint a single-use code at the
 * API (bound to the PKCE challenge) and 302 the code back into the app. The app
 * exchanges that code for tokens over TLS — tokens never transit the URL.
 *
 * The code returns over the shell's **loopback redirect** (`http://127.0.0.1:
 * <port>/cb`, RFC 8252 §7.3) when one is supplied — this reaches an unpackaged
 * `dist/main.js` dev run, which the `sidanclaw://auth` custom scheme cannot. We
 * only ever redirect to a loopback host, never an arbitrary URL, so this can't
 * be turned into an open redirect that leaks the code. With no (or an invalid)
 * `redirect`, we fall back to `sidanclaw://auth` for older / packaged builds.
 *
 * Failure handling keeps the user in the desktop flow: any failure 302s back to
 * the app with `error=…` so it shows a native dialog, except a missing browser
 * session, which goes through the normal `/login` with a `next` back here
 * (carrying the full query so `redirect`/`state` survive the round-trip).
 *
 * Spec: docs/architecture/platform/auth.md → "Desktop app sign-in (PKCE handoff)".
 * Component tag: [COMP:app-web/desktop-auth-bridge].
 */

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const SCHEME = "sidanclaw";
const CHALLENGE_RE = /^[A-Za-z0-9_-]{16,256}$/;
const STATE_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * 302 the code/error back to the app. To the loopback server when one was
 * supplied (preferred), else to the `sidanclaw://auth` scheme. `state` is echoed
 * so the loopback server can reject a callback that isn't from its sign-in.
 */
function redirectToApp(
  params: Record<string, string>,
  loopbackBase: string | null,
  state: string | null,
): NextResponse {
  const qs = new URLSearchParams(params);
  if (state) qs.set("state", state);
  const location = loopbackBase
    ? `${loopbackBase}?${qs.toString()}`
    : `${SCHEME}://auth?${qs.toString()}`;
  return new NextResponse(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = url.searchParams.get("challenge") ?? "";
  const loopbackBase = loopbackRedirectBase(url.searchParams.get("redirect"));
  const stateRaw = url.searchParams.get("state");
  const state = stateRaw && STATE_RE.test(stateRaw) ? stateRaw : null;

  if (!CHALLENGE_RE.test(challenge)) {
    return redirectToApp({ error: "bad_request" }, loopbackBase, state);
  }

  // Add-account (desktop): do NOT silently reuse the browser's current session.
  // Route through `/login?addAccount=1` so Google shows the account chooser and a
  // DIFFERENT account signs in, then return to a CLEAN bridge URL (addAccount
  // stripped) that mints the code for the newly-chosen account. Stripping
  // addAccount from `next` is what prevents an infinite login→bridge loop.
  if (url.searchParams.get("addAccount") === "1") {
    const ret = new URL(url);
    ret.searchParams.delete("addAccount");
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("addAccount", "1");
    loginUrl.searchParams.set("next", `/desktop/auth${ret.search}`);
    return NextResponse.redirect(loginUrl);
  }

  const accessToken = parseLastCookie(request.headers.get("cookie") ?? "", "access_token");

  // No browser session: send the user through normal login, returning here. The
  // full query (challenge + redirect + state) rides in `next` so it survives.
  if (!accessToken) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `/desktop/auth${url.search}`);
    return NextResponse.redirect(loginUrl);
  }

  try {
    const res = await fetch(`${API_URL}/auth/desktop/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ challenge }),
      cache: "no-store",
    });

    if (res.status === 401) {
      // Access token expired between page loads — re-auth, then return here.
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", `/desktop/auth${url.search}`);
      return NextResponse.redirect(loginUrl);
    }
    if (!res.ok) {
      return redirectToApp({ error: "mint_failed" }, loopbackBase, state);
    }

    const { code } = (await res.json()) as { code?: string };
    if (!code) return redirectToApp({ error: "mint_failed" }, loopbackBase, state);

    return redirectToApp({ code }, loopbackBase, state);
  } catch (err) {
    console.error("[desktop-auth] mint failed:", err);
    return redirectToApp({ error: "mint_failed" }, loopbackBase, state);
  }
}
