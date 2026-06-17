/**
 * `next/navigation` shim for the desktop Vite SPA (Approach B). Maps Next's
 * App-Router hooks onto react-router so app-web's client components run
 * unmodified under Vite. Aliased to `next/navigation` in vite.desktop.config.ts.
 *
 * Under HashRouter (file:// can't use the history API), `useLocation().pathname`
 * is the path after `#`, which is exactly what app-web parses (e.g.
 * `pageIdFromPathname`), so the path-based helpers work as-is.
 */
import { useMemo, useRef } from "react";
import {
  useNavigate,
  useLocation,
  useParams as rrUseParams,
} from "react-router-dom";

/** Strip a same-doc origin if a full URL is passed; keep path + search + hash. */
function toPath(href: string): string {
  if (href.startsWith("/")) return href;
  try {
    const u = new URL(href, "http://_");
    return u.pathname + u.search + u.hash;
  } catch {
    return href;
  }
}

export function useRouter() {
  // The router object MUST be referentially stable for the WHOLE component
  // lifetime — Next's `useRouter()` is, and app-web relies on it: the
  // doc-shell's `tabs → URL` reconcile effect is keyed on
  // `[tabsActivePage, …, router]` and is designed to fire ONLY when the active
  // page changes. A changing `router` re-fires it on the lagging click render
  // and ping-pongs `/p` ↔ `/p/<id>` forever.
  //
  // Crucially, react-router's `useNavigate()` is NOT stable — it rebinds on every
  // location change (to support relative navigation), so memoizing on `[navigate]`
  // still churns. So we hold the latest `navigate` in a ref and build the router
  // ONCE (`useMemo([])`), calling `navRef.current` — a permanently stable object.
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  return useMemo(
    () => ({
      push: (href: string) => navRef.current(toPath(href)),
      replace: (href: string) => navRef.current(toPath(href), { replace: true }),
      back: () => navRef.current(-1),
      forward: () => navRef.current(1),
      refresh: () => {},
      prefetch: () => {},
    }),
    [],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
  const search = useLocation().search;
  // Stable identity per search string (some consumers use it as an effect dep).
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T {
  return rrUseParams() as T;
}

/** Best-effort SPA equivalent of Next's `redirect` (navigates the hash route). */
export function redirect(href: string): never {
  window.location.hash = "#" + toPath(href);
  // Match Next's "redirect throws" control flow so callers stop rendering.
  throw new Error("NEXT_REDIRECT:" + href);
}

export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}

/** Rarely used by client components; harmless no-op stand-ins. */
export function permanentRedirect(href: string): never {
  return redirect(href);
}
export const RedirectType = { push: "push", replace: "replace" } as const;
