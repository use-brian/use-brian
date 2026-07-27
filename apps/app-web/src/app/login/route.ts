import { NextResponse } from "next/server";
import {
  buildDelegatedLoginUrl,
  webAppUrl,
} from "@/lib/primary-auth";
import { ossSignedOutRedirect } from "@/lib/oss-entry";

/**
 * Redirect-only compatibility entry for app-origin `/login`.
 *
 * Interactive account authentication belongs to the primary web app, whose
 * canonical login offers every supported provider. This route deliberately
 * renders no HTML: the deleted predecessor was a client-side Google-only page
 * that flashed before forwarding hosted users to the real login.
 *
 * Hosted production → the configured auth primary.
 * Hosted development → apps/web on localhost:3000.
 * OSS → the local-owner session (there is no hosted account login).
 *
 * Spec: docs/architecture/platform/auth.md → "Design rule: usebrian.ai →
 * sub-app, not the other way round".
 * [COMP:app-web/login-delegation]
 */

const ERROR_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Resolve a requested app-origin return without letting `/login` become an
 * open-redirect relay. The canonical primary re-validates the URL too.
 */
export function resolveAppLoginReturn(
  requestUrl: URL,
  rawNext: string | null,
): URL {
  if (!rawNext || rawNext.startsWith("//")) return new URL(requestUrl.origin);
  try {
    const candidate = new URL(rawNext, requestUrl.origin);
    return candidate.origin === requestUrl.origin
      ? candidate
      : new URL(requestUrl.origin);
  } catch {
    return new URL(requestUrl.origin);
  }
}

export function GET(request: Request): NextResponse {
  const requestUrl = new URL(request.url);
  const returnUrl = resolveAppLoginReturn(
    requestUrl,
    requestUrl.searchParams.get("next"),
  );
  const returnPath = `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;

  const ossEntry = ossSignedOutRedirect(returnPath);
  if (ossEntry) {
    return NextResponse.redirect(new URL(ossEntry, requestUrl));
  }

  const rawError = requestUrl.searchParams.get("error");
  const error = rawError && ERROR_RE.test(rawError) ? rawError : null;
  return NextResponse.redirect(
    buildDelegatedLoginUrl(webAppUrl(), returnUrl.toString(), {
      addAccount: requestUrl.searchParams.get("addAccount") === "1",
      error,
    }),
  );
}
