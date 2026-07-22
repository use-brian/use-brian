import { describe, it, expect } from "vitest";

import {
  CLOUD_API_URL,
  CLOUD_APP_URL,
  DEFAULT_LOCAL_APP_URL,
  acceptDeclaredApiUrl,
  cloudTarget,
  deriveApiUrl,
  desktopConfigUrl,
  deriveLocalApiUrl,
  healthUrl,
  localMintUrl,
  localTarget,
  normalizeTargetUrl,
  parseDesktopConfig,
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
      label: "Use Brian Cloud",
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
    const cloud = { kind: "cloud" as const, label: "Use Brian Cloud" };
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

describe("[COMP:app-desktop/target-store] declared API (GET /api/desktop-config)", () => {
  // A reverse-proxied self-host is the case hostname derivation cannot serve:
  // its API is on 443 under a name that is neither an `api.` sibling nor the
  // same host on :4000, so without a declaration the shell probes a dead port.
  const PROXIED_APP = "https://brain.example.com";
  const PROXIED_API = "https://backend.example.com";

  it("builds the config URL off the normalized app base", () => {
    expect(desktopConfigUrl("http://localhost:3003")).toBe(
      "http://localhost:3003/api/desktop-config",
    );
  });

  it("derivation alone strands a reverse-proxied self-host on an unreachable :4000", () => {
    expect(deriveLocalApiUrl(PROXIED_APP)).toBe(`${PROXIED_APP}:4000`);
  });

  it("a declared API outranks the hostname guess", () => {
    expect(localTarget(PROXIED_APP, PROXIED_API)?.apiUrl).toBe(PROXIED_API);
  });

  it("falls back to derivation with no declaration, or a rejected one", () => {
    expect(localTarget(PROXIED_APP)?.apiUrl).toBe(`${PROXIED_APP}:4000`);
    expect(localTarget(PROXIED_APP, null)?.apiUrl).toBe(`${PROXIED_APP}:4000`);
    expect(localTarget(PROXIED_APP, "not a url")?.apiUrl).toBe(`${PROXIED_APP}:4000`);
  });

  it("accepts a normalized http(s) declaration and strips trailing slashes", () => {
    expect(acceptDeclaredApiUrl(`${PROXIED_API}/`)).toBe(PROXIED_API);
    expect(acceptDeclaredApiUrl("http://localhost:4000")).toBe("http://localhost:4000");
  });

  it("REFUSES a declaration pointing at the cloud API (paired-API-only rule)", () => {
    // A typo'd or hostile self-host must not aim the shell's sign-in exchange
    // and refresh traffic at the origin where a real cloud session lives.
    expect(acceptDeclaredApiUrl(CLOUD_API_URL)).toBeNull();
    expect(acceptDeclaredApiUrl(`${CLOUD_API_URL}/v1`)).toBeNull();
    expect(localTarget(PROXIED_APP, CLOUD_API_URL)?.apiUrl).toBe(`${PROXIED_APP}:4000`);
  });

  it("rejects a non-http(s) declaration", () => {
    expect(acceptDeclaredApiUrl("file:///etc/passwd")).toBeNull();
    expect(acceptDeclaredApiUrl("")).toBeNull();
  });

  it("parses the declared apiUrl out of a config body, tolerating junk", () => {
    expect(parseDesktopConfig({ apiUrl: PROXIED_API, edition: "oss" })).toBe(PROXIED_API);
    expect(parseDesktopConfig({})).toBeNull();
    expect(parseDesktopConfig({ apiUrl: "" })).toBeNull();
    expect(parseDesktopConfig({ apiUrl: 42 })).toBeNull();
    expect(parseDesktopConfig(null)).toBeNull();
    expect(parseDesktopConfig([{ apiUrl: PROXIED_API }])).toBeNull();
    expect(parseDesktopConfig("nope")).toBeNull();
    // The cloud guard holds through the parse seam too.
    expect(parseDesktopConfig({ apiUrl: CLOUD_API_URL })).toBeNull();
  });

  it("round-trips the declaration through the persisted record", () => {
    const raw = serializePersistedTarget("local", PROXIED_APP, PROXIED_API);
    expect(parsePersistedTarget(raw)).toEqual({
      v: 1,
      kind: "local",
      appUrl: PROXIED_APP,
      apiUrl: PROXIED_API,
    });
    expect(resolveTargetFromPersisted(raw).apiUrl).toBe(PROXIED_API);
  });

  it("keeps the declaration while parked on cloud, so the way back still works", () => {
    const raw = serializePersistedTarget("cloud", PROXIED_APP, PROXIED_API);
    const rec = parsePersistedTarget(raw);
    expect(rec?.kind).toBe("cloud");
    expect(rec?.apiUrl).toBe(PROXIED_API);
    // Parked on cloud, the resolved target is still the cloud one.
    expect(resolveTargetFromPersisted(raw).apiUrl).toBe(CLOUD_API_URL);
  });

  it("omits an absent or rejected declaration from the record", () => {
    expect(parsePersistedTarget(serializePersistedTarget("local", PROXIED_APP))).toEqual({
      v: 1,
      kind: "local",
      appUrl: PROXIED_APP,
    });
    expect(
      parsePersistedTarget(serializePersistedTarget("local", PROXIED_APP, CLOUD_API_URL)),
    ).toEqual({ v: 1, kind: "local", appUrl: PROXIED_APP });
  });

  it("re-validates a hand-edited record rather than trusting it", () => {
    const handEdited = JSON.stringify({ v: 1, kind: "local", appUrl: PROXIED_APP, apiUrl: CLOUD_API_URL });
    expect(parsePersistedTarget(handEdited)?.apiUrl).toBeUndefined();
    // ...and the resolved target derives instead of reaching the cloud API.
    expect(resolveTargetFromPersisted(handEdited).apiUrl).toBe(`${PROXIED_APP}:4000`);
  });
});
