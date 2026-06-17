import { afterEach, describe, expect, it } from "vitest";
import { getAccountsDir, setAccountsDirCache } from "@/lib/accounts";

/** Stub `document.cookie` for the reader (doc vitest runs DOM-free). */
function setCookie(value: string | null) {
  if (value === null) {
    // @ts-expect-error test stub — simulate a server (no document) context
    delete globalThis.document;
    return;
  }
  // @ts-expect-error test stub
  globalThis.document = { cookie: value };
}

function dirCookie(dir: unknown): string {
  return `accounts_dir=${encodeURIComponent(JSON.stringify(dir))}`;
}

afterEach(() => {
  setAccountsDirCache([]); // reset the module cache between cases
  // @ts-expect-error test stub
  delete globalThis.document;
});

describe("[COMP:app-web/accounts] getAccountsDir", () => {
  it("returns [] when the accounts_dir cookie is absent", () => {
    setCookie("locale=en; theme=dark");
    expect(getAccountsDir()).toEqual([]);
  });

  it("parses the account directory from the cookie", () => {
    const dir = [{ id: "u1", name: "Ada", email: "ada@x.com" }];
    setCookie(dirCookie(dir));
    expect(getAccountsDir()).toEqual(dir);
  });

  it("picks the last accounts_dir value when a migration twin precedes it", () => {
    const stale = [{ id: "old", name: "Old", email: "old@x.com" }];
    const fresh = [{ id: "new", name: "New", email: "new@x.com" }];
    setCookie(`${dirCookie(stale)}; ${dirCookie(fresh)}`);
    expect(getAccountsDir()).toEqual(fresh);
  });

  it("falls back to the cached value on malformed JSON", () => {
    const good = [{ id: "u1", name: "Ada", email: "ada@x.com" }];
    setCookie(dirCookie(good));
    expect(getAccountsDir()).toEqual(good); // primes the cache
    setCookie("accounts_dir=%7Bnot-json");
    expect(getAccountsDir()).toEqual(good); // cache retained, never throws
  });

  it("returns [] on the server when there is no document", () => {
    setCookie(null);
    expect(getAccountsDir()).toEqual([]);
  });
});
