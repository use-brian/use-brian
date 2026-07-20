"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { primaryAuthUrl } from "@/lib/primary-auth";
import { useT } from "@/lib/i18n/client";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

// Build-time inlined by Next.js. Gates the local dev sign-in affordance so it
// is compiled out of any production bundle. The backing route + backend
// endpoint are independently gated — see
// src/app/api/auth/dev-login/route.ts.
const IS_DEV = process.env.NODE_ENV !== "production";

function sanitizeNext(raw: string | null): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith("/")) return undefined;
  if (raw.startsWith("//")) return undefined;
  return raw;
}

function buildOAuthState(nextPath: string | undefined, addAccount: boolean): string {
  const payload: Record<string, string> = {};
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) payload.timezone = tz;
  } catch {
    // Intl unsupported — sign-in proceeds without tz seed.
  }
  if (nextPath) payload.nextPath = nextPath;
  // Multi-account "add" intent — carried through to the OAuth callback (mirrors
  // apps/web's login). In the desktop shell the add-account stashing is done by
  // the Electron shell itself; this still forces Google's account chooser below.
  if (addAccount) payload.addAccount = "1";
  const json = JSON.stringify(payload);
  const b64 =
    typeof window === "undefined"
      ? Buffer.from(json).toString("base64")
      : btoa(json);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function handleGoogleLogin(nextPath: string | undefined, addAccount: boolean) {
  const redirectUri = `${window.location.origin}/api/auth/callback/google`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    // Add-account must force the account chooser so a DIFFERENT account can be
    // picked; a plain login reuses the browser's current Google session.
    prompt: addAccount ? "select_account" : "consent",
    state: buildOAuthState(nextPath, addAccount),
  });
  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function LoginInner() {
  const t = useT().login;
  const searchParams = useSearchParams();
  const nextPath = sanitizeNext(searchParams.get("next"));
  // Add-account flow (the switcher's "Add another account", incl. the desktop
  // shell routing its bridge through here). Forces the Google account chooser and
  // is forwarded to the primary in prod so its reverse-guard doesn't skip login.
  const addAccount = searchParams.get("addAccount") === "1";
  // Only the local dev-login failure surfaces a message here; the OAuth
  // error codes bounce through to the primary in prod and aren't shown.
  const errorMessage =
    searchParams.get("error") === "dev_login_failed"
      ? t.errorDevLogin
      : undefined;

  // Per the design rule "usebrian.ai → sub-app, not the other way round",
  // production sign-in happens at usebrian.ai (it's the only origin that
  // can write the shared `.usebrian.ai` cookies). This page renders only
  // the moment between mount and the redirect, then unloads. Dev keeps
  // the local Google button because localhost can't share cookies.
  useEffect(() => {
    const primary = primaryAuthUrl();
    if (!primary) return;
    const target = new URL("/login", primary);
    if (typeof window !== "undefined") {
      const returnTo = nextPath
        ? new URL(nextPath, window.location.origin).toString()
        : window.location.origin;
      target.searchParams.set("next", returnTo);
    }
    // Forward the add-account intent so the primary forces the account chooser
    // (and its already-signed-in reverse-guard doesn't skip the login screen).
    if (addAccount) target.searchParams.set("addAccount", "1");
    window.location.replace(target.toString());
  }, [nextPath, addAccount]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none animate-fade-in"
        style={{
          background:
            "radial-gradient(circle at 50% 30%, rgba(52, 211, 255, 0.10) 0%, rgba(11, 16, 32, 0) 60%), radial-gradient(circle at 80% 80%, rgba(52, 211, 255, 0.05) 0%, transparent 50%)",
        }}
      />
      <div
        aria-hidden
        className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full blur-3xl opacity-40 pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(52,211,255,0.16) 0%, transparent 65%)",
        }}
      />
      <div className="w-full max-w-sm space-y-8 relative z-10 animate-rise-in">
        <div className="text-center space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icon.png"
            alt=""
            className="mx-auto h-14 w-14 rounded-2xl ring-1 ring-primary/30 shadow-[0_8px_30px_-10px_color-mix(in_srgb,var(--primary)_50%,transparent)]"
          />
          <h1
            className="text-3xl font-bold tracking-tight"
            style={{ fontFamily: "var(--font-rocknroll)" }}
          >
            {t.title}
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">
            {t.description}
          </p>
        </div>
        {errorMessage ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground"
          >
            {errorMessage}
          </div>
        ) : null}
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => handleGoogleLogin(nextPath, addAccount)}
            className="w-full h-12 rounded-xl border border-border bg-card/80 backdrop-blur-sm hover:bg-card hover:border-primary/40 hover:shadow-[0_0_24px_-4px_rgba(52,211,255,0.25)] active:scale-[0.99] transition-all duration-200 inline-flex items-center justify-center gap-3 text-sm font-medium press"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            {t.continueWithGoogle}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
