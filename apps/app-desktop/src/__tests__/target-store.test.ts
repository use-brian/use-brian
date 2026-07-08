import { describe, it, expect } from "vitest";

import {
  CLOUD_API_URL,
  CLOUD_APP_URL,
  DEFAULT_LOCAL_APP_URL,
  cloudTarget,
  deriveApiUrl,
  deriveLocalApiUrl,
  healthUrl,
  localMintUrl,
  localTarget,
  normalizeTargetUrl,
  parsePersistedTarget,
  resolveTargetFromPersisted,
  serializePersistedTarget,
  targetWindowTitle,
} from "../target-store.js";

describe("[COMP:app-desktop/target-store] normalizeTargetUrl", () => {
  it("accepts http(s), trims, and strips trailing slashes", () => {
    expect(normalizeTargetUrl("http://localhost:3003/")).toBe("http://localhost:3003");
    expect(normalizeTargetUrl("  https://brain.example.com  ")).toBe("https://brain.example.com");
    expect(normalizeTargetUrl("https://host.example/canvas///")).toBe(
      "https://host.example/canvas",
    );
  });

  it("drops query and hash (a target is a base URL, not a page)", () => {
    expect(normalizeTargetUrl("http://localhost:3003/?capture=1#x")).toBe("http://localhost:3003");
  });

  it("rejects non-http(s) and unparseable input", () => {
    expect(normalizeTargetUrl("")).toBeNull();
    expect(normalizeTargetUrl("   ")).toBeNull();
    expect(normalizeTargetUrl("not a url")).toBeNull();
    expect(normalizeTargetUrl("ftp://host")).toBeNull();
    expect(normalizeTargetUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeTargetUrl("localhost:3003")).toBeNull(); // no scheme
  });
});

describe("[COMP:app-desktop/target-store] deriveApiUrl (cloud/dev pairing)", () => {
  it("keeps the historical pairing: localhost, app./canvas. prefix, else the prod API", () => {
    expect(deriveApiUrl("http://localhost:3003")).toBe("http://localhost:4000");
    expect(deriveApiUrl("http://127.0.0.1:3003")).toBe("http://localhost:4000");
    expect(deriveApiUrl("https://app.example.com")).toBe("https://api.example.com");
    expect(deriveApiUrl("https://canvas.example.com")).toBe("https://api.example.com");
    expect(deriveApiUrl(CLOUD_APP_URL)).toBe(CLOUD_API_URL);
    expect(deriveApiUrl("https://unrelated.example.com")).toBe(CLOUD_API_URL);
    expect(deriveApiUrl("garbage")).toBe(CLOUD_API_URL);
  });
});

describe("[COMP:app-desktop/target-store] deriveLocalApiUrl", () => {
  it("pairs localhost with the local API and prefixed hosts with their api. sibling", () => {
    expect(deriveLocalApiUrl("http://localhost:3003")).toBe("http://localhost:4000");
    expect(deriveLocalApiUrl("http://127.0.0.1:3003")).toBe("http://localhost:4000");
    expect(deriveLocalApiUrl("https://app.brain.example.com")).toBe(
      "https://api.brain.example.com",
    );
  });

  it("NEVER falls back to the cloud API: an arbitrary self-hosted origin pairs same-host :4000", () => {
    expect(deriveLocalApiUrl("http://myserver.tail1234.ts.net:3003")).toBe(
      "http://myserver.tail1234.ts.net:4000",
    );
    expect(deriveLocalApiUrl("https://brain.example.com")).toBe("https://brain.example.com:4000");
    expect(deriveLocalApiUrl("garbage")).toBe("http://localhost:4000");
  });
});

describe("[COMP:app-desktop/target-store] targets", () => {
  it("cloudTarget is the shipped default (PKCE auth)", () => {
    const t = cloudTarget();
    expect(t).toEqual({
      kind: "cloud",
      appUrl: CLOUD_APP_URL,
      apiUrl: CLOUD_API_URL,
      auth: "pkce",
      label: "sidanclaw Cloud",
    });
    expect(Object.isFrozen(t)).toBe(true);
  });

  it("localTarget defaults to the launcher address and derives the paired API + label", () => {
    const t = localTarget();
    expect(t).toEqual({
      kind: "local",
      appUrl: DEFAULT_LOCAL_APP_URL,
      apiUrl: "http://localhost:4000",
      auth: "local-session",
      label: "Local Brain (localhost:3003)",
    });
  });

  it("localTarget normalizes a custom URL and refuses an invalid one", () => {
    const t = localTarget("https://brain.example.com:8443/");
    expect(t?.appUrl).toBe("https://brain.example.com:8443");
    expect(t?.apiUrl).toBe("https://brain.example.com:4000");
    expect(t?.label).toBe("Local Brain (brain.example.com:8443)");
    expect(localTarget("not a url")).toBeNull();
    expect(localTarget("ftp://x")).toBeNull();
  });
});

describe("[COMP:app-desktop/target-store] persisted record serde", () => {
  it("round-trips cloud and local records (local keeps the remembered address)", () => {
    expect(parsePersistedTarget(serializePersistedTarget("cloud"))).toEqual({
      v: 1,
      kind: "cloud",
    });
    expect(
      parsePersistedTarget(serializePersistedTarget("cloud", "http://localhost:3003")),
    ).toEqual({ v: 1, kind: "cloud", appUrl: "http://localhost:3003" });
    expect(parsePersistedTarget(serializePersistedTarget("local", "http://myhost:3003/"))).toEqual(
      { v: 1, kind: "local", appUrl: "http://myhost:3003" },
    );
  });

  it("parses tolerantly: malformed input is null, a bad appUrl is dropped", () => {
    expect(parsePersistedTarget(null)).toBeNull();
    expect(parsePersistedTarget("")).toBeNull();
    expect(parsePersistedTarget("{not json")).toBeNull();
    expect(parsePersistedTarget("[]")).toBeNull();
    expect(parsePersistedTarget('"local"')).toBeNull();
    expect(parsePersistedTarget('{"kind":"other"}')).toBeNull();
    expect(parsePersistedTarget('{"kind":"local","appUrl":"ftp://x"}')).toEqual({
      v: 1,
      kind: "local",
    });
  });

  it("resolveTargetFromPersisted: null/corrupt/cloud -> cloud; local -> its address or the default", () => {
    expect(resolveTargetFromPersisted(null).kind).toBe("cloud");
    expect(resolveTargetFromPersisted("{oops").kind).toBe("cloud");
    expect(resolveTargetFromPersisted(serializePersistedTarget("cloud")).kind).toBe("cloud");

    const remembered = resolveTargetFromPersisted(
      serializePersistedTarget("local", "http://myserver:3003"),
    );
    expect(remembered.kind).toBe("local");
    expect(remembered.appUrl).toBe("http://myserver:3003");
    expect(remembered.apiUrl).toBe("http://myserver:4000");
    expect(remembered.auth).toBe("local-session");

    const bare = resolveTargetFromPersisted('{"kind":"local"}');
    expect(bare.appUrl).toBe(DEFAULT_LOCAL_APP_URL);
  });
});

describe("[COMP:app-desktop/target-store] indicator + URL helpers", () => {
  it("suffixes page titles for a local target only (empty title -> the label alone)", () => {
    const local = { kind: "local" as const, label: "Local Brain (localhost:3003)" };
    const cloud = { kind: "cloud" as const, label: "sidanclaw Cloud" };
    expect(targetWindowTitle("Inbox", local)).toBe("Inbox · Local Brain (localhost:3003)");
    expect(targetWindowTitle("  ", local)).toBe("Local Brain (localhost:3003)");
    expect(targetWindowTitle("Inbox", cloud)).toBe("Inbox");
  });

  it("builds the mint + health URLs off the normalized bases", () => {
    expect(localMintUrl("http://localhost:3003")).toBe(
      "http://localhost:3003/api/auth/local-session",
    );
    expect(healthUrl("http://localhost:4000")).toBe("http://localhost:4000/health");
  });
});
