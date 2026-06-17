/**
 * Navigation-progress signal — the framework-free half of the global loading
 * bar (`components/route-progress.tsx`).
 *
 * The desktop shell (apps/app-desktop) loads the app with no browser chrome,
 * so a click that triggers a client-side App Router transition has no native
 * tab spinner to fall back on — the window looks frozen until the new route
 * commits. This module is the shared "a navigation is in flight" flag the
 * visible bar subscribes to. It's a plain module-level store (no React, no
 * `next/*`) so it unit-tests in plain Node and so any button-driven navigation
 * (a page-row select, the workspace switch) can call `start()` without
 * prop-drilling a context down to it.
 *
 * Most navigations are `<a>`/`<Link>` clicks the bar catches itself via a
 * document click listener filtered by `isInternalNavigation` below; `start()`
 * is the explicit escape hatch for the button-driven ones.
 *
 * [COMP:app-web/route-progress]
 */

type Listener = () => void;

let active = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const routeProgress = {
  /** Mark a navigation as started (idempotent while already active). */
  start(): void {
    if (active) return;
    active = true;
    emit();
  },
  /** Mark the in-flight navigation as finished (idempotent while idle). */
  done(): void {
    if (!active) return;
    active = false;
    emit();
  },
  /** Current flag — the `useSyncExternalStore` snapshot. */
  getSnapshot(): boolean {
    return active;
  },
  /** Server snapshot — always idle (no navigation in flight during SSR). */
  getServerSnapshot(): boolean {
    return false;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/**
 * Should a click on this anchor light up the progress bar? True only for a
 * real in-app navigation — a same-origin link that actually changes the
 * **pathname** and isn't asking the browser to do something else.
 *
 * Scoped to pathname changes on purpose: the bar's `done()` is driven by a
 * `usePathname()` change, so a same-page query-only or hash click would never
 * finish it (it would hang until the safety timeout). Those are rare in this
 * path-based app and usually instant client updates, so skipping them is the
 * right trade.
 *
 * Modifier keys / non-left-click are the caller's concern (a DOM `MouseEvent`
 * detail the listener checks before calling this); this stays pure so it tests
 * without a DOM. `href` is the anchor's resolved absolute URL
 * (`HTMLAnchorElement.href`), so it's safe to feed straight to `new URL`.
 */
export function isInternalNavigation(opts: {
  /** The anchor's resolved absolute href (`a.href`), or null/empty. */
  href: string | null | undefined;
  /** The anchor's `target` attribute, if any. */
  target: string | null | undefined;
  /** Whether the anchor carries a `download` attribute. */
  hasDownload: boolean;
  /** `window.location.origin`. */
  origin: string;
  /** `window.location.href` — used to detect a no-op same-page click. */
  currentUrl: string;
}): boolean {
  const { href, target, hasDownload, origin, currentUrl } = opts;
  if (!href) return false;
  if (hasDownload) return false;
  // A target other than the current frame opens elsewhere (new tab/window).
  if (target && target !== "_self") return false;

  let url: URL;
  let current: URL;
  try {
    url = new URL(href);
    current = new URL(currentUrl);
  } catch {
    return false;
  }

  // External origin (and, by extension, mailto:/tel:/etc.) leaves the app.
  if (url.origin !== origin) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  // Same pathname → a hash jump or a query-only/current-page click. `done()`
  // keys on a pathname change, so the bar would just hang until the safety
  // timeout; skip it.
  if (url.pathname === current.pathname) return false;
  return true;
}
