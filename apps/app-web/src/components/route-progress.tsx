"use client";

/**
 * Global navigation progress bar — a thin sliver pinned to the top of the
 * viewport that animates while an App Router navigation is in flight, then
 * fades out.
 *
 * Why this exists: the desktop shell (apps/app-desktop) loads the app with
 * `titleBarStyle: "hiddenInset"` and NO browser chrome, so a click that kicks
 * off a client-side route transition (a sidebar surface icon, a page row, the
 * workspace switcher) had no "something is happening" signal — the window just
 * looked frozen until the new content committed. This is the doc surface's
 * replacement for the browser's native tab spinner; the browser benefits too.
 *
 * Mounted ONCE in the root `layout.tsx` so it spans every surface. It:
 *  - starts on any internal `<a>`/`<Link>` click via a single capture-phase
 *    `document` listener (no per-link wiring), filtered by `isInternalNavigation`;
 *  - finishes when `usePathname()` changes (the route committed), with an 8s
 *    safety timeout so it can never hang;
 *  - waits a 100ms show-delay before painting, so instant navigations never
 *    flash it, and fades out via CSS opacity.
 *
 * It is decorative (`aria-hidden`) — screen readers get the new page's
 * title/content. Button-driven navigations that don't go through an `<a>` call
 * `routeProgress.start()` directly (see `route-progress.ts`).
 *
 * [COMP:app-web/route-progress]
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { routeProgress, isInternalNavigation } from "@/lib/route-progress";

/** Hold off painting until a navigation has run this long (skip instant ones). */
const SHOW_DELAY_MS = 100;
/** Never let the bar hang if a navigation never commits (e.g. a no-op push). */
const SAFETY_TIMEOUT_MS = 8000;

export function RouteProgress() {
  const active = useSyncExternalStore(
    routeProgress.subscribe,
    routeProgress.getSnapshot,
    routeProgress.getServerSnapshot,
  );
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  // A committed route change (pathname changed) ends the in-flight navigation.
  // Runs on mount too, where `done()` is a harmless no-op (nothing in flight).
  useEffect(() => {
    routeProgress.done();
  }, [pathname]);

  // React to the in-flight flag. The show-delay timer is cancelled the instant
  // the navigation finishes, so a sub-100ms transition never flashes the bar.
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const showTimer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    const safetyTimer = window.setTimeout(
      () => routeProgress.done(),
      SAFETY_TIMEOUT_MS,
    );
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(safetyTimer);
    };
  }, [active]);

  // Catch every internal `<a>`/`<Link>` click app-wide. Capture phase so we see
  // it before Next's own handler; the pure classifier decides if it's a real
  // in-app navigation (and we skip modified / non-left clicks here).
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented) return;
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (
        isInternalNavigation({
          href: anchor.href,
          target: anchor.getAttribute("target"),
          hasDownload: anchor.hasAttribute("download"),
          origin: window.location.origin,
          currentUrl: window.location.href,
        })
      ) {
        routeProgress.start();
      }
    }
    document.addEventListener("click", onClick, { capture: true });
    return () =>
      document.removeEventListener("click", onClick, { capture: true });
  }, []);

  return (
    <div className="route-progress" data-active={visible} aria-hidden="true">
      <div className="route-progress__bar" />
    </div>
  );
}
