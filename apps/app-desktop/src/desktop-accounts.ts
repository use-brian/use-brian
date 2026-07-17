/**
 * Desktop multi-account — the shell's jar-local copy of the web's saved-account
 * model.
 *
 * The web keeps every account signed in on a browser in two `.usebrian.ai` cookies
 * (`accounts_store` httpOnly + `accounts_dir` JS-readable; see
 * `apps/web/src/lib/auth-cookies.ts`) and delegates switching to the primary's
 * `switch-account-and-return` route. The desktop shell can do **neither**: its
 * session lives in a separate host-only Electron cookie jar the primary could
 * never write, and to the nav policy the primary is an external origin (a switch
 * bounce would open the system browser, not switch the in-app jar). So the shell
 * owns the same model locally — the SAME two cookies, host-only on the app
 * origin — and switches by refreshing with a stored token and reinstalling the
 * canonical trio, exactly the way the web's `switch-account-and-return` does.
 *
 * Everything here is pure / Electron-free so it unit-tests with no Electron;
 * `main.ts` does the jar I/O. Mirrors the pure pieces of the web's
 * `auth-cookies.ts` (`computeAccountStoreUpdate` add-branch, `rotateActiveAccount`,
 * `upsertAccountDir`, `parsePrevUserCookie`) so the two surfaces stay in step.
 *
 * Spec: docs/architecture/features/app-desktop.md → "Multi-account" and
 * docs/architecture/platform/auth.md → "Multi-account switching".
 * [COMP:app-desktop/desktop-accounts]
 */

import type { SessionCookieSpec } from "./desktop-auth.js";

/** Server-only map of userId → that account's refresh token (mirrors web's `AccountStore`). */
export type AccountStore = Record<string, string>;

/** One signed-in account, as rendered in the switcher dropdown (mirrors web's `AccountDirEntry`). */
export interface AccountDirEntry {
  id: string;
  name: string;
  email: string;
}

/** A `(directory entry, refresh token)` pair — an account plus the credential to revive it. */
export interface AccountCredential {
  account: AccountDirEntry;
  refreshToken: string;
}

/**
 * Max accounts kept in the store, matching the web's `MAX_ACCOUNTS`. Bounds the
 * `accounts_store` cookie under the ~4KB per-cookie limit (a refresh JWT is
 * ≈250-400B). The add flow refuses a brand-new account beyond this; re-adding an
 * account already in the store is always fine.
 */
export const MAX_ACCOUNTS = 8;

/** 30 days in seconds — the store/dir cookie lifetime, matching `refresh_token`. */
const STORE_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Tolerantly parse a JSON cookie value. Electron returns jar cookie values as
 * they were set, but a value can come back percent-encoded depending on how it
 * was written, so try the raw string first and then a URL-decoded pass before
 * giving up. Returns `fallback` on anything malformed. Never throws.
 */
function parseJsonCookie<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  for (const candidate of [raw, safeDecode(raw)]) {
    if (candidate == null) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next candidate */
    }
  }
  return fallback;
}

function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Read the account store from a raw jar cookie value (mirrors `readAccountStore`). */
export function parseAccountStore(raw: string | null | undefined): AccountStore {
  const parsed = parseJsonCookie<unknown>(raw, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as AccountStore)
    : {};
}

/** Read the account directory from a raw jar cookie value (mirrors `readAccountDir`). */
export function parseAccountDir(raw: string | null | undefined): AccountDirEntry[] {
  const parsed = parseJsonCookie<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as AccountDirEntry[]) : [];
}

/**
 * Decode the canonical `user` cookie value into a directory entry, or `null`
 * when it is absent / malformed / id-less. Mirrors the web's
 * `parsePrevUserCookie` — a legacy cookie predating the `id` field can't be
 * stashed (no stable key) and is skipped (re-added on its next sign-in). The
 * shell writes `user` as `{ id, name, email, plan, effectivePlan }`
 * (`buildSessionCookies`); we keep only the directory fields.
 */
export function parseUserCookieValue(raw: string | null | undefined): AccountDirEntry | null {
  const parsed = parseJsonCookie<Partial<AccountDirEntry>>(raw, {} as Partial<AccountDirEntry>);
  if (!parsed.id || !parsed.email) return null;
  return { id: parsed.id, name: parsed.name ?? parsed.email, email: parsed.email };
}

/** Insert or replace (by id) an entry in the directory; returns a new array (mirrors `upsertAccountDir`). */
export function upsertAccountDir(
  dir: AccountDirEntry[],
  entry: AccountDirEntry,
): AccountDirEntry[] {
  return [...dir.filter((e) => e.id !== entry.id), entry];
}

/**
 * Add-account computation — the add-branch of the web's
 * `computeAccountStoreUpdate`. Stashes the current active account (`prev`, whose
 * trio is about to be overwritten) into the store, then adds the newly
 * authenticated account (`next`) and makes it active.
 *
 * Returns `atCapacity: true` (and the store/dir unchanged) when the store is
 * already full of *other* accounts and `next` isn't one of them — the caller
 * keeps the current session and surfaces the cap. Re-adding an account already
 * in the store is always allowed. Pure — does not mutate its inputs.
 */
export function stashAndAddAccount(
  store: AccountStore,
  dir: AccountDirEntry[],
  prev: AccountCredential | null,
  next: AccountCredential,
): { store: AccountStore; dir: AccountDirEntry[]; atCapacity: boolean } {
  const outStore: AccountStore = { ...store };
  let outDir = [...dir];

  if (prev) {
    outStore[prev.account.id] = prev.refreshToken;
    outDir = upsertAccountDir(outDir, prev.account);
  }

  if (!outStore[next.account.id] && Object.keys(outStore).length >= MAX_ACCOUNTS) {
    return { store, dir, atCapacity: true };
  }

  outStore[next.account.id] = next.refreshToken;
  outDir = upsertAccountDir(outDir, next.account);
  return { store: outStore, dir: outDir, atCapacity: false };
}

/**
 * Switch-rotation computation — the store side of a switch. Writes back the
 * current active account's (possibly keep-alive-rotated) token, then records the
 * switched-to account's freshly rotated token. The R1 invariant: any route that
 * refreshes an account must persist the rotated token so a later switch doesn't
 * fail on a consumed one. Pure — does not mutate its inputs.
 */
export function applySwitchRotation(
  store: AccountStore,
  dir: AccountDirEntry[],
  prevActive: AccountCredential | null,
  switched: AccountCredential,
): { store: AccountStore; dir: AccountDirEntry[] } {
  const outStore: AccountStore = { ...store };
  let outDir = [...dir];

  if (prevActive) {
    outStore[prevActive.account.id] = prevActive.refreshToken;
    outDir = upsertAccountDir(outDir, prevActive.account);
  }

  outStore[switched.account.id] = switched.refreshToken;
  outDir = upsertAccountDir(outDir, switched.account);
  return { store: outStore, dir: outDir };
}

/**
 * R1 write-back for the active account during normal use — mirrors the web's
 * `rotateActiveAccount`. Returns the updated store/dir, or `null` when this jar
 * has no saved-account store yet (a single-account session that never opted into
 * multi-account — nothing to sync). Called from the keep-alive after the active
 * account's token rotates so a later "switch back" doesn't rely on a stale one.
 */
export function rotateActiveInStore(
  store: AccountStore,
  dir: AccountDirEntry[],
  active: AccountCredential,
): { store: AccountStore; dir: AccountDirEntry[] } | null {
  if (Object.keys(store).length === 0) return null;
  const outStore: AccountStore = { ...store, [active.account.id]: active.refreshToken };
  const outDir = upsertAccountDir(dir, active.account);
  return { store: outStore, dir: outDir };
}

/**
 * Drop a dead account from the store + directory (a confirmed-revoked stored
 * token). Mirrors the prune the web's `switch-account-and-return` does before
 * surfacing `reauth`. Pure — returns new collections.
 */
export function pruneAccount(
  store: AccountStore,
  dir: AccountDirEntry[],
  accountId: string,
): { store: AccountStore; dir: AccountDirEntry[] } {
  const outStore: AccountStore = { ...store };
  delete outStore[accountId];
  return { store: outStore, dir: dir.filter((e) => e.id !== accountId) };
}

/**
 * Plan a single-account sign-out in the shell jar: drop `activeId` from the
 * store + directory and list the remaining account ids to try switching into,
 * most-recently-used first (the dir appends on `upsertAccountDir`, so its last
 * entry is the newest). Mirrors the web's `planActiveLogout`
 * (`apps/web/src/lib/auth-cookies.ts`). The caller refreshes each candidate's
 * stored token in turn and installs the first that succeeds; if none remain or
 * none can be revived, it does a full sign-out. Pure — does not mutate inputs.
 */
export function planActiveLogout(
  store: AccountStore,
  dir: AccountDirEntry[],
  activeId: string | null,
): { store: AccountStore; dir: AccountDirEntry[]; candidates: string[] } {
  const outStore: AccountStore = { ...store };
  if (activeId) delete outStore[activeId];
  const outDir = activeId ? dir.filter((e) => e.id !== activeId) : [...dir];
  const candidates = outDir
    .map((e) => e.id)
    .reverse()
    .filter((id) => Boolean(outStore[id]));
  return { store: outStore, dir: outDir, candidates };
}

/**
 * Build the two saved-account cookie specs the shell writes into its jar, keyed
 * to the app origin. `accounts_store` is httpOnly (it holds refresh tokens, like
 * `refresh_token`); `accounts_dir` is JS-readable so the switcher's
 * `getAccountsDir()` can render the rows. Both share `refresh_token`'s 30-day
 * lifetime and the same attributes `buildSessionCookies` uses.
 *
 * @param nowSeconds injectable clock (unix seconds) for deterministic tests
 */
export function buildAccountStoreCookies(
  appUrl: string,
  store: AccountStore,
  dir: AccountDirEntry[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionCookieSpec[] {
  const secure = appUrl.startsWith("https://");
  const base = { url: appUrl, secure, sameSite: "lax" as const };
  const expirationDate = nowSeconds + STORE_TTL_SECONDS;
  return [
    {
      ...base,
      name: "accounts_store",
      value: JSON.stringify(store),
      httpOnly: true,
      expirationDate,
    },
    {
      ...base,
      name: "accounts_dir",
      value: JSON.stringify(dir),
      httpOnly: false,
      expirationDate,
    },
  ];
}
