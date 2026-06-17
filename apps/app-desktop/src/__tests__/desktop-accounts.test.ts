import { describe, it, expect } from "vitest";

import {
  parseAccountStore,
  parseAccountDir,
  parseUserCookieValue,
  upsertAccountDir,
  stashAndAddAccount,
  applySwitchRotation,
  rotateActiveInStore,
  pruneAccount,
  planActiveLogout,
  buildAccountStoreCookies,
  MAX_ACCOUNTS,
  type AccountStore,
  type AccountDirEntry,
  type AccountCredential,
} from "../desktop-accounts.js";

const entry = (id: string): AccountDirEntry => ({
  id,
  name: `User ${id}`,
  email: `${id}@example.com`,
});

const cred = (id: string, token = `rt-${id}`): AccountCredential => ({
  account: entry(id),
  refreshToken: token,
});

describe("[COMP:app-desktop/desktop-accounts] cookie parsing", () => {
  it("parses a raw JSON store and directory", () => {
    expect(parseAccountStore('{"a":"rt-a","b":"rt-b"}')).toEqual({ a: "rt-a", b: "rt-b" });
    expect(parseAccountDir('[{"id":"a","name":"A","email":"a@x.io"}]')).toEqual([
      { id: "a", name: "A", email: "a@x.io" },
    ]);
  });

  it("parses a URL-encoded value (jar may percent-encode)", () => {
    const dir = [entry("a")];
    const encoded = encodeURIComponent(JSON.stringify(dir));
    expect(parseAccountDir(encoded)).toEqual(dir);
  });

  it("falls back to empty on null / malformed / wrong-shape values", () => {
    expect(parseAccountStore(null)).toEqual({});
    expect(parseAccountStore("")).toEqual({});
    expect(parseAccountStore("not json")).toEqual({});
    expect(parseAccountStore("[1,2,3]")).toEqual({}); // array is not a store
    expect(parseAccountDir(undefined)).toEqual([]);
    expect(parseAccountDir('{"not":"an array"}')).toEqual([]);
  });

  it("parses the canonical user cookie into a directory entry, dropping plan fields", () => {
    const raw = JSON.stringify({
      id: "u1",
      name: "Ada",
      email: "ada@x.io",
      plan: "max_5x",
      effectivePlan: "max_5x",
    });
    expect(parseUserCookieValue(raw)).toEqual({ id: "u1", name: "Ada", email: "ada@x.io" });
  });

  it("rejects a user cookie with no id or email (legacy / malformed)", () => {
    expect(parseUserCookieValue(null)).toBeNull();
    expect(parseUserCookieValue(JSON.stringify({ name: "x", email: "x@x.io" }))).toBeNull();
    expect(parseUserCookieValue(JSON.stringify({ id: "u1", name: "x" }))).toBeNull();
  });

  it("backfills name from email when the user cookie has none", () => {
    expect(parseUserCookieValue(JSON.stringify({ id: "u1", email: "u1@x.io" }))).toEqual({
      id: "u1",
      name: "u1@x.io",
      email: "u1@x.io",
    });
  });
});

describe("[COMP:app-desktop/desktop-accounts] upsertAccountDir", () => {
  it("appends a new entry and replaces an existing one by id", () => {
    const dir = [entry("a")];
    expect(upsertAccountDir(dir, entry("b"))).toEqual([entry("a"), entry("b")]);
    const renamed = { id: "a", name: "Renamed", email: "a@example.com" };
    expect(upsertAccountDir(dir, renamed)).toEqual([renamed]);
  });
});

describe("[COMP:app-desktop/desktop-accounts] stashAndAddAccount", () => {
  it("stashes the current active account, then adds + activates the new one", () => {
    const { store, dir, atCapacity } = stashAndAddAccount({}, [], cred("a"), cred("b"));
    expect(atCapacity).toBe(false);
    expect(store).toEqual({ a: "rt-a", b: "rt-b" });
    expect(dir).toEqual([entry("a"), entry("b")]);
  });

  it("adds the first account when there is no prior active session", () => {
    const { store, dir } = stashAndAddAccount({}, [], null, cred("a"));
    expect(store).toEqual({ a: "rt-a" });
    expect(dir).toEqual([entry("a")]);
  });

  it("re-adding an existing account refreshes its token without growing the store", () => {
    const start: AccountStore = { a: "rt-a", b: "old" };
    const { store, atCapacity } = stashAndAddAccount(start, [entry("a"), entry("b")], cred("a"), cred("b", "new"));
    expect(atCapacity).toBe(false);
    expect(store).toEqual({ a: "rt-a", b: "new" });
  });

  it("refuses a brand-new account at capacity, leaving inputs untouched", () => {
    const full: AccountStore = {};
    const dir: AccountDirEntry[] = [];
    for (let i = 0; i < MAX_ACCOUNTS; i++) {
      full[`u${i}`] = `rt-${i}`;
      dir.push(entry(`u${i}`));
    }
    const res = stashAndAddAccount(full, dir, null, cred("new"));
    expect(res.atCapacity).toBe(true);
    expect(res.store).toBe(full); // unchanged reference on refusal
    expect(res.dir).toBe(dir);
  });

  it("allows re-adding an account already saved even at capacity", () => {
    const full: AccountStore = {};
    const dir: AccountDirEntry[] = [];
    for (let i = 0; i < MAX_ACCOUNTS; i++) {
      full[`u${i}`] = `rt-${i}`;
      dir.push(entry(`u${i}`));
    }
    const res = stashAndAddAccount(full, dir, null, cred("u0", "rotated"));
    expect(res.atCapacity).toBe(false);
    expect(res.store.u0).toBe("rotated");
    expect(Object.keys(res.store)).toHaveLength(MAX_ACCOUNTS);
  });

  it("does not mutate the input collections", () => {
    const store: AccountStore = { a: "rt-a" };
    const dir = [entry("a")];
    stashAndAddAccount(store, dir, cred("a"), cred("b"));
    expect(store).toEqual({ a: "rt-a" });
    expect(dir).toEqual([entry("a")]);
  });
});

describe("[COMP:app-desktop/desktop-accounts] applySwitchRotation", () => {
  it("writes back the current active token, then records the switched-to rotated token", () => {
    const store: AccountStore = { a: "stale-a", b: "stale-b" };
    const dir = [entry("a"), entry("b")];
    // Switching away from A (whose jar token rotated to fresh-a) to B (refresh
    // produced fresh-b).
    const { store: out, dir: outDir } = applySwitchRotation(
      store,
      dir,
      cred("a", "fresh-a"),
      cred("b", "fresh-b"),
    );
    expect(out).toEqual({ a: "fresh-a", b: "fresh-b" });
    expect(outDir).toEqual([entry("a"), entry("b")]);
  });

  it("handles a switch with no prior active account", () => {
    const { store } = applySwitchRotation({ b: "old" }, [entry("b")], null, cred("b", "fresh"));
    expect(store).toEqual({ b: "fresh" });
  });
});

describe("[COMP:app-desktop/desktop-accounts] rotateActiveInStore", () => {
  it("no-ops (returns null) when there is no saved-account store", () => {
    expect(rotateActiveInStore({}, [], cred("a", "fresh"))).toBeNull();
  });

  it("updates the active account's stored token + dir when a store exists", () => {
    const res = rotateActiveInStore({ a: "old", b: "rt-b" }, [entry("a"), entry("b")], cred("a", "fresh"));
    expect(res).not.toBeNull();
    expect(res!.store).toEqual({ a: "fresh", b: "rt-b" });
    // upsert moves the touched entry to the end (matches web's upsertAccountDir).
    expect(res!.dir).toEqual([entry("b"), entry("a")]);
  });
});

describe("[COMP:app-desktop/desktop-accounts] pruneAccount", () => {
  it("drops a dead account from store + directory", () => {
    const { store, dir } = pruneAccount(
      { a: "rt-a", b: "dead" },
      [entry("a"), entry("b")],
      "b",
    );
    expect(store).toEqual({ a: "rt-a" });
    expect(dir).toEqual([entry("a")]);
  });

  it("is a no-op for an unknown account id", () => {
    const { store, dir } = pruneAccount({ a: "rt-a" }, [entry("a")], "zzz");
    expect(store).toEqual({ a: "rt-a" });
    expect(dir).toEqual([entry("a")]);
  });
});

describe("[COMP:app-desktop/desktop-accounts] planActiveLogout", () => {
  it("drops the active account and lists the rest most-recently-used first", () => {
    // dir is oldest→newest (upsert appends), so reversed = newest first.
    const { store, dir, candidates } = planActiveLogout(
      { a: "rt-a", b: "rt-b", c: "rt-c" },
      [entry("a"), entry("b"), entry("c")],
      "b",
    );
    expect(store).toEqual({ a: "rt-a", c: "rt-c" });
    expect(dir).toEqual([entry("a"), entry("c")]);
    expect(candidates).toEqual(["c", "a"]);
  });

  it("returns no candidates when the active account is the only one (→ full sign-out)", () => {
    const { store, dir, candidates } = planActiveLogout({ a: "rt-a" }, [entry("a")], "a");
    expect(store).toEqual({});
    expect(dir).toEqual([]);
    expect(candidates).toEqual([]);
  });

  it("keeps every account as a candidate when there is no active id", () => {
    const { candidates } = planActiveLogout(
      { a: "rt-a", b: "rt-b" },
      [entry("a"), entry("b")],
      null,
    );
    expect(candidates).toEqual(["b", "a"]);
  });

  it("skips a dir entry that has no stored token", () => {
    const { candidates } = planActiveLogout(
      { a: "rt-a" }, // b has a dir entry but no stored token
      [entry("a"), entry("b")],
      null,
    );
    expect(candidates).toEqual(["a"]);
  });
});

describe("[COMP:app-desktop/desktop-accounts] buildAccountStoreCookies", () => {
  const store: AccountStore = { a: "rt-a" };
  const dir = [entry("a")];

  it("emits an httpOnly store cookie and a JS-readable dir cookie, 30d, on the app origin", () => {
    const now = 1_000_000;
    const specs = buildAccountStoreCookies("https://app.sidan.ai", store, dir, now);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));

    expect(byName.accounts_store).toMatchObject({
      url: "https://app.sidan.ai",
      name: "accounts_store",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      expirationDate: now + 30 * 24 * 60 * 60,
    });
    expect(JSON.parse(byName.accounts_store.value)).toEqual(store);

    expect(byName.accounts_dir).toMatchObject({ name: "accounts_dir", httpOnly: false });
    expect(JSON.parse(byName.accounts_dir.value)).toEqual(dir);
  });

  it("marks cookies insecure for an http (dev) origin", () => {
    const specs = buildAccountStoreCookies("http://localhost:3003", store, dir, 0);
    expect(specs.every((s) => s.secure === false)).toBe(true);
  });

  it("round-trips through the cookie parsers", () => {
    const specs = buildAccountStoreCookies("https://app.sidan.ai", store, dir, 0);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s.value]));
    expect(parseAccountStore(byName.accounts_store)).toEqual(store);
    expect(parseAccountDir(byName.accounts_dir)).toEqual(dir);
  });
});
