"use client";

/**
 * Feed OAuth return landing. The connect flow returns to
 * `/w/<id>/feed/<platform>/settings?connected=<platform>` (on the web, or in
 * the desktop app through its `usebrian://open` deep link), and the callback
 * appends `error=<platform>_<reason>` when the connect did not finish.
 *
 * The page must never read a just-finished connect as "not connected": the
 * surface paints its last cached record first, and a slow profile read can
 * trail it. So the landing re-reads from the network (`refresh()` is
 * network-only once the record is loaded) and retries while the new profile
 * is still missing, then reports one of: connected, unconfirmed (sign-in
 * finished but the account has not shown up yet), or the callback's error.
 *
 * Spec: docs/architecture/feed/twitter.md -> "Return landing".
 * [COMP:app-web/feed-connect-landing]
 */

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type ConnectLandingStatus =
  | { kind: "none" }
  | { kind: "confirming" }
  | { kind: "connected" }
  | { kind: "unconfirmed" }
  | { kind: "denied" }
  | { kind: "failed" };

const LANDING_PARAMS = ["connected", "error", "twitter_connected", "threads_connected"];

/** Backoff between network re-reads while the new profile is missing. */
const CONFIRM_DELAYS_MS = [0, 2_000, 4_000, 8_000];

/**
 * Read the landing params for THIS platform. Pure. An `error` for another
 * platform, or a `connected` naming another platform, is not this page's.
 */
export function parseConnectLanding(
  search: string,
  platform: string,
): ConnectLandingStatus {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error && error.startsWith(`${platform}_`)) {
    return error === `${platform}_consent_denied`
      ? { kind: "denied" }
      : { kind: "failed" };
  }
  if (params.get("connected") === platform) return { kind: "confirming" };
  return { kind: "none" };
}

/**
 * The route query without the landing params (other params survive). Takes
 * the ROUTER's query, never `window.location`: the bundled desktop SPA routes
 * through the hash, so its `location.search` is the file's own query.
 */
export function stripConnectLandingParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of LANDING_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export function useFeedConnectLanding(params: {
  platform: string;
  connected: boolean;
  refresh: () => Promise<void>;
}): ConnectLandingStatus {
  const { platform, connected, refresh } = params;
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const search = searchParams?.toString() ?? "";
  const [status, setStatus] = useState<ConnectLandingStatus>(() =>
    parseConnectLanding(search, platform),
  );
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  // The provider rebuilds `refresh` whenever the record changes; a ref keeps
  // the retry loop from restarting on every refresh it causes.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Strip the params once read, so a reload or a shared link does not replay
  // the landing.
  const hasLandingParams = parseConnectLanding(search, platform).kind !== "none";
  useEffect(() => {
    if (!hasLandingParams || !pathname) return;
    router.replace(`${pathname}${stripConnectLandingParams(search)}`);
  }, [hasLandingParams, pathname, router, search]);

  const confirming = status.kind === "confirming";
  useEffect(() => {
    if (!confirming) return;
    let cancelled = false;
    void (async () => {
      for (const delay of CONFIRM_DELAYS_MS) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        if (connectedRef.current) break;
        await refreshRef.current().catch(() => undefined);
        if (cancelled) return;
        if (connectedRef.current) break;
      }
      if (cancelled) return;
      setStatus(
        connectedRef.current ? { kind: "connected" } : { kind: "unconfirmed" },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [confirming]);

  // The profile can land from any refresh (this loop, the sidebar's shared
  // record), so settle as soon as it appears.
  useEffect(() => {
    if (connected && (status.kind === "confirming" || status.kind === "unconfirmed")) {
      setStatus({ kind: "connected" });
    }
  }, [connected, status.kind]);

  return status;
}
