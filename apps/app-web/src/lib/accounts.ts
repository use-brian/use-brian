/**
 * Client-side reader for the multi-account directory cookie (`accounts_dir`).
 * Cloned from `apps/web/src/lib/accounts.ts`.
 *
 * In **production** the primary (usebrian.ai) writes `accounts_dir` scoped to
 * `.usebrian.ai`, so it rides along to `app.usebrian.ai` and this reader sees
 * every account signed in on the browser. The companion httpOnly
 * `accounts_store` is intentionally NOT read here (or needed): app-web is a
 * sub-app and may not write the shared cookies, so switching is delegated to
 * the primary's `/api/auth/switch-account-and-return` redirect rather than
 * done locally. This file is for rendering the dropdown only.
 *
 * In **dev** there is no shared cookie scope (host-only `localhost` cookies)
 * and "Add another account" punts to the web app, so `accounts_dir` is
 * typically absent here — the switcher falls back to the single active user,
 * which is the pre-existing single-account behaviour.
 *
 * Like `lib/user.ts`, reads the LAST `accounts_dir=` value in
 * `document.cookie` (the `.usebrian.ai` migration can leave a host-only twin
 * before the domain-scoped one; per RFC 6265 §5.4 the most-recently-set value
 * is last) and caches at module scope so the switcher doesn't flash an empty
 * list between client navigations.
 */

export type AccountDirEntry = {
  id: string;
  name: string;
  email: string;
};

let cachedDir: AccountDirEntry[] | null = null;

/**
 * Read the saved-account directory from the `accounts_dir` cookie. Returns an
 * empty array when no accounts are stored (a single-account session, or dev).
 * Never throws.
 */
export function getAccountsDir(): AccountDirEntry[] {
  if (typeof document === "undefined") return cachedDir ?? [];
  const re = /(?:^|;\s*)accounts_dir=([^;]*)/g;
  let lastValue: string | null = null;
  for (const m of document.cookie.matchAll(re)) lastValue = m[1];
  if (lastValue === null) {
    cachedDir = [];
    return [];
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(lastValue)) as unknown;
    const dir = Array.isArray(parsed) ? (parsed as AccountDirEntry[]) : [];
    cachedDir = dir;
    return dir;
  } catch {
    return cachedDir ?? [];
  }
}

/** Overwrite the module cache — call after a successful mutation so the
 *  dropdown updates in place without a reload. */
export function setAccountsDirCache(dir: AccountDirEntry[]): void {
  cachedDir = dir;
}
