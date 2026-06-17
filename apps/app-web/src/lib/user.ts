/**
 * Read the current user from the `user` cookie. Cloned from
 * apps/web/src/lib/user.ts. The module-level cache survives React
 * remounts so the UI doesn't flash "Guest" on every navigation.
 *
 * [COMP:app-web/user]
 */

export type UserInfo = {
  id?: string;
  name: string;
  email: string;
  /** Profile photo URL, carried on the shared `.sidan.ai` `user` cookie. A
   *  hot-linked Google photo or our own avatar-proxy URL; absent → initials.
   *  See `docs/architecture/platform/user-profile.md`. */
  avatarUrl?: string;
};

let cachedUser: UserInfo | null = null;

export function getUserInfo(): UserInfo | null {
  if (typeof document === "undefined") return cachedUser;
  const info = selectActiveUser(document.cookie);
  if (info) cachedUser = info;
  return info ?? cachedUser;
}

/**
 * Choose the `user` cookie that matches the *authenticated* account, robust to
 * duplicate cookies (a `.sidan.ai` domain cookie + a stale host-only twin).
 *
 * The old read picked the LAST `user=` occurrence, leaning on RFC 6265 §5.4
 * ordering ("oldest first"). That ordering isn't reliable across browsers or
 * once a twin is re-set — and a cross-origin account switch
 * (`switch-account-and-return` on the primary) re-sets the `.sidan.ai` cookie
 * yet **cannot clear the host-only twin on this sub-app's own host** (a
 * different origin), so a stale twin can sort last. The switcher derives its
 * active-account checkmark (and its "is this the current account?" switch
 * guard) from `getUserInfo()`, so reading the stale twin pins the UI to the
 * account the user just switched AWAY from: the switch looks like it did
 * nothing, and re-clicking just re-bounces. (The `access_token` already dodges
 * this via `selectFreshestAccessToken`, so the Bearer session *does* switch —
 * only the display stuck, which is the confusing part.)
 *
 * So anchor on the SIGNED source of truth instead of cookie position: the
 * account the freshest `access_token` authenticates as (its JWT `sub`). Return
 * the `user` candidate whose `id` matches it. This is the `user`-cookie analog
 * of `selectFreshestAccessToken` (`auth-fetch.ts`) — both resolve the same twin
 * order-independently, so the displayed account and the Bearer-authenticated
 * account never disagree.
 *
 * Falls back to the positional last when there is a single cookie, no decodable
 * `access_token`, or a legacy id-less `user` cookie (predating the `id` field)
 * — preserving the prior behavior in every non-twin case. Pure + exported for
 * tests (the app-web vitest env has no `document`). See
 * `docs/architecture/platform/auth.md` → "Duplicate cookies after the
 * .sidan.ai migration".
 */
export function selectActiveUser(cookie: string): UserInfo | null {
  const candidates: UserInfo[] = [];
  const re = /(?:^|;\s*)user=([^;]*)/g;
  for (const m of cookie.matchAll(re)) {
    const parsed = parseUserCookieValue(m[1]);
    if (parsed) candidates.push(parsed);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple `user` cookies → don't trust position. Pick the one whose id is
  // the freshest `access_token`'s `sub`; that token is what the API actually
  // authenticates as, so the display tracks the real session.
  const activeId = freshestAccessTokenSub(cookie);
  if (activeId) {
    const match = candidates.find((c) => c.id === activeId);
    if (match) return match;
  }
  // No token, or no id match (legacy id-less cookie) → last wins, as before.
  return candidates[candidates.length - 1];
}

/** Parse one `user=` cookie value (URL-encoded JSON; tolerates a double-encode). */
function parseUserCookieValue(raw: string): UserInfo | null {
  try {
    const once = decodeURIComponent(raw);
    try {
      return JSON.parse(once) as UserInfo;
    } catch {
      return JSON.parse(decodeURIComponent(once)) as UserInfo;
    }
  } catch {
    return null;
  }
}

/**
 * The `sub` (user id) of the furthest-future `access_token` in a raw Cookie
 * string. Mirrors `selectFreshestAccessToken`'s `exp`-based pick, kept local to
 * avoid a circular import (`auth-fetch.ts` already imports from this module) —
 * the same way `jwtExpSeconds` is duplicated in `auth-fetch.ts` and
 * `desktop-auth.ts`. Returns null when no candidate carries a decodable JWT.
 */
function freshestAccessTokenSub(cookie: string): string | null {
  const re = /(?:^|;\s*)access_token=([^;]*)/g;
  let bestSub: string | null = null;
  let bestExp = -Infinity;
  for (const m of cookie.matchAll(re)) {
    const claims = decodeJwtClaims(m[1]);
    if (!claims) continue;
    const exp = typeof claims.exp === "number" ? claims.exp : 0;
    // `>=` so a later candidate wins ties, matching selectFreshestAccessToken.
    if (exp >= bestExp) {
      bestExp = exp;
      bestSub = typeof claims.sub === "string" ? claims.sub : null;
    }
  }
  return bestSub;
}

/** Decode a JWT payload's claims (`exp`/`sub`). Returns null when unparseable. */
function decodeJwtClaims(token: string): { exp?: number; sub?: string } | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
      sub?: string;
    };
  } catch {
    return null;
  }
}

export function setUserInfoCache(info: UserInfo | null): void {
  cachedUser = info;
}

export function getCachedUserInfo(): UserInfo | null {
  return cachedUser;
}

export function getInitials(nameOrEmail: string): string {
  if (!nameOrEmail) return "?";
  const source = nameOrEmail.includes("@")
    ? nameOrEmail.split("@")[0].replace(/[._-]+/g, " ")
    : nameOrEmail;
  const first = source.trim()[0];
  return first ? first.toUpperCase() : "?";
}
