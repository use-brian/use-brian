/**
 * [COMP:app-web/desktop-config-route] Deployment self-description for the
 * desktop shell.
 *
 * `GET /api/desktop-config` is how a self-hosted brain tells the Electron
 * shell where its own backend lives, so the user types ONE address and the
 * shell stops guessing from the hostname (`deriveLocalApiUrl` covers only
 * `localhost`, an `api.` sibling, and same-host `:4000` — a reverse-proxied
 * self-host serving its API on 443 under an unrelated name was unreachable).
 *
 * The module reads its env at import time (module-scope consts, mirroring how
 * Next inlines `NEXT_PUBLIC_*` at build), so every case re-imports under
 * `vi.resetModules()` with the env set first.
 *
 * Spec: docs/architecture/features/app-desktop.md → "The declared API".
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = [
  "NEXT_PUBLIC_API_URL",
  "API_URL",
  "NEXT_PUBLIC_DOC_SYNC_URL",
  "NEXT_PUBLIC_USEBRIAN_EDITION",
  // Scrubbed too: server-side `isOssEdition()` also honours this runtime var,
  // so leaving an ambient value set would decide the edition cases for us.
  "USEBRIAN_EDITION",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Import the route fresh so its module-scope env reads re-evaluate. */
async function getConfig(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { GET } = await import("../route");
  const res = await GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("[COMP:app-web/desktop-config-route] GET /api/desktop-config", () => {
  it("reports the BROWSER-facing API origin, not the server-side hop", async () => {
    // The case that motivates the whole endpoint: on a reverse-proxied
    // self-host these differ — the browser dials the public hostname while
    // API_URL is an internal localhost hop. The shell must dial what the
    // browser dials, or its token exchange lands on the wrong backend.
    process.env.NEXT_PUBLIC_API_URL = "https://backend.example.com";
    process.env.API_URL = "http://localhost:4000";

    const { status, body } = await getConfig();
    expect(status).toBe(200);
    expect(body.apiUrl).toBe("https://backend.example.com");
  });

  it("falls back to the server-side API_URL when only that is set", async () => {
    process.env.API_URL = "https://api.example.com";
    expect((await getConfig()).body.apiUrl).toBe("https://api.example.com");
  });

  it("falls back to the local dev API when neither is set", async () => {
    expect((await getConfig()).body.apiUrl).toBe("http://localhost:4000");
  });

  it("reports the doc-sync origin when pinned, else null", async () => {
    process.env.NEXT_PUBLIC_DOC_SYNC_URL = "wss://docsync.example.com";
    expect((await getConfig()).body.docSyncUrl).toBe("wss://docsync.example.com");

    vi.resetModules();
    delete process.env.NEXT_PUBLIC_DOC_SYNC_URL;
    expect((await getConfig()).body.docSyncUrl).toBeNull();
  });

  it("reports the edition, so the shell can explain a hosted-edition self-host", async () => {
    // A hosted-edition brain is reachable but cannot mint a local-owner
    // session; the shell surfaces that instead of stranding the user on a 404.
    process.env.NEXT_PUBLIC_USEBRIAN_EDITION = "oss";
    expect((await getConfig()).body.edition).toBe("oss");

    vi.resetModules();
    delete process.env.NEXT_PUBLIC_USEBRIAN_EDITION;
    expect((await getConfig()).body.edition).toBe("hosted");
  });

  it("is uncached — a moved backend must not be served from a stale copy", async () => {
    const { GET } = await import("../route");
    expect((await GET()).headers.get("Cache-Control")).toBe("no-store");
  });

  it("discloses only the public origins the client bundle already carries", async () => {
    process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";
    const { body } = await getConfig();
    expect(Object.keys(body).sort()).toEqual(["apiUrl", "docSyncUrl", "edition"]);
  });
});
