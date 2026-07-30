"use client";

/**
 * Custom Home app frame — the host side of running someone else's code.
 *
 * The app renders in `<iframe sandbox="allow-scripts allow-forms">` with **no
 * `allow-same-origin`**, so the bundle executes at an OPAQUE origin: no
 * cookies, no storage, no reach into app-web, even though its bytes are served
 * from our API origin. That single omission is what makes API-origin serving
 * safe without per-app subdomains, and it is the reason this component exists
 * in the shape it does — everything below follows from the frame having no
 * ambient authority at all:
 *
 *   - it cannot read a cookie, so the entry URL is a signed capability URL;
 *   - it cannot use localStorage, so app state goes through bridge KV;
 *   - it cannot call our API with a session, so it gets a scoped bridge token
 *     over `postMessage`.
 *
 * The postMessage channel is origin-checked in BOTH directions. Inbound: an
 * opaque-origin frame posts with `origin: "null"`, and we additionally require
 * the message to have come from THIS iframe's own `contentWindow` — the origin
 * string alone is not identifying, since every sandboxed frame on the page
 * shares it. Outbound: we target `"*"` because an opaque origin cannot be
 * named, which is safe only because the payload goes to a window we created
 * and hold a reference to.
 *
 * Host verbs are deliberately minimal:
 *   `ub:ready`    → host replies `ub:token` with the bridge token
 *   `ub:token`    → refresh (the token is short-lived)
 *   `ub:navigate` → deep-link into a Brian surface, in-app paths only
 *
 * There is no data verb. Apps reach the brain through the brain-MCP server
 * using the bridge token, which is the same scope- and clearance-gated surface
 * a brain key gets.
 *
 * Spec: docs/architecture/features/home-apps.md → "Serving + the bridge".
 * [COMP:app-web/home-app-frame]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Lock, Puzzle } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT, format } from "@/lib/i18n/client";
import { fetchHomeAppSession, type HomeAppSession } from "@/lib/api/home-apps";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Only in-app paths. A `ub:navigate` carrying an absolute URL would make the
 * app an open redirector wearing our chrome — the same validation
 * `normalizeNavigateUrl` applies to computer-use targets.
 */
export function normalizeAppNavigatePath(
  raw: unknown,
  workspaceId: string,
): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  // Reject anything that could resolve off-site: schemes, protocol-relative
  // paths, and backslashes (which some parsers treat as separators).
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (raw.includes("://")) return null;
  // Confine to this workspace. An app must not be able to navigate the user
  // into a workspace it was never installed in.
  const prefix = `/w/${workspaceId}`;
  if (raw !== prefix && !raw.startsWith(`${prefix}/`)) return null;
  return raw;
}

export function AppFrame({
  workspaceId,
  appId,
}: {
  workspaceId: string;
  appId: string;
}) {
  const t = useT().homeApps;
  const router = useRouter();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [session, setSession] = useState<HomeAppSession | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setSession(await fetchHomeAppSession(appId));
    setLoading(false);
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh the bridge token before it expires. The frame can also ask, but a
  // long-lived dashboard that never asks would silently lose brain access
  // mid-session, which reads to the user as the app being broken.
  useEffect(() => {
    if (!session?.bridgeTokenTtlMs) return;
    const timer = setInterval(() => void load(), Math.max(session.bridgeTokenTtlMs / 2, 60_000));
    return () => clearInterval(timer);
  }, [load, session?.bridgeTokenTtlMs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMessage = (event: MessageEvent) => {
      // An opaque-origin frame always posts `origin: "null"`, so the origin
      // string cannot identify WHICH frame sent this. The source-window check
      // is the one that actually binds the message to our app.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown };
      if (!data || typeof data.type !== "string") return;

      const post = (payload: Record<string, unknown>) => {
        // `"*"` because an opaque origin cannot be named as a target. Safe
        // only because the window is one we created and hold a ref to.
        frameRef.current?.contentWindow?.postMessage(payload, "*");
      };

      switch (data.type) {
        case "ub:ready":
        case "ub:token": {
          post({
            type: "ub:token",
            token: session?.bridgeToken ?? null,
            apiOrigin: API_URL,
            appId,
            workspaceId,
          });
          break;
        }
        case "ub:navigate": {
          const path = normalizeAppNavigatePath(data.path, workspaceId);
          if (path) router.push(path);
          break;
        }
        default:
          // Unknown verb — ignore. The bridge vocabulary is allowlisted, so a
          // newer SDK talking to an older host degrades instead of breaking.
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [appId, router, session?.bridgeToken, workspaceId]);

  const chrome = (body: React.ReactNode) => (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar app="page" customApp={{ name: session?.name ?? t.fallbackName, icon: session?.icon ?? null }} />
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );

  if (loading) {
    return chrome(
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
        {t.loading}
      </div>,
    );
  }

  if (!session) {
    return chrome(
      <EmptyState icon={AlertTriangle} title={t.notFoundTitle} body={t.notFoundBody} />,
    );
  }

  // Not renderable — say WHICH of the three reasons, because each has a
  // different person who can fix it and a different next step.
  if (!session.renderable) {
    if (session.status === "needs_consent") {
      return chrome(
        <EmptyState
          icon={Lock}
          title={t.needsConsentTitle}
          body={format(t.needsConsentBody, { name: session.name })}
        />,
      );
    }
    if (session.status === "disabled") {
      return chrome(
        <EmptyState icon={Lock} title={t.disabledTitle} body={t.disabledBody} />,
      );
    }
    return chrome(
      <EmptyState
        icon={AlertTriangle}
        title={t.syncErrorTitle}
        body={session.syncError ?? t.syncErrorBody}
      />,
    );
  }

  return chrome(
    <iframe
      ref={frameRef}
      src={`${API_URL}${session.entryUrl}`}
      title={session.name}
      // NO `allow-same-origin`. Adding it collapses the whole security model:
      // the bundle would run on our API origin with access to its cookies and
      // storage. Everything the app needs instead arrives over the bridge.
      sandbox="allow-scripts allow-forms"
      className="size-full border-0 bg-background"
    />,
  );
}

function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Puzzle;
  title: string;
  body: string;
}) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-2 px-6 text-center">
      <Icon className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  );
}
