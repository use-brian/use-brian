import { describe, expect, it } from "vitest";
import { DeploymentAccounts, TargetOperations, deploymentAccountKey, deploymentKey, deploymentKind, type AccountTarget } from "../deployment-accounts.js";
import { parseDesktopConfig } from "../target-store.js";
import type { StoredTokens } from "../desktop-token-store.js";

const cloud: AccountTarget = { kind: "cloud", appUrl: "https://app.usebrian.ai", apiUrl: "https://api.usebrian.ai", auth: "pkce" };
const local: AccountTarget = { kind: "local", appUrl: "http://localhost:3003", apiUrl: "http://localhost:4000", auth: "local-session" };
const tokens = (id: string, refreshToken = "refresh"): StoredTokens => ({
  accessToken: "access",
  refreshToken,
  accessTokenExpiresAt: 1000,
  user: {
    id,
    name: "Example User",
    email: "person@example.com",
    avatarUrl: "https://cdn.example/avatar.png",
  },
});
function setup(available = true) {
  let disk: Buffer = Buffer.alloc(0);
  const cipher = { isAvailable: () => available, encryptString: (text: string) => Buffer.from(text).reverse(), decryptString: (blob: Buffer) => Buffer.from(blob).reverse().toString() };
  const store = new DeploymentAccounts(cipher, () => disk, (blob) => { disk = blob; });
  return { store, bytes: () => disk };
}

describe("[COMP:app-desktop/deployment-accounts] saved sessions", () => {
  it("keeps matching user IDs on different deployments separate and never lists tokens", () => {
    const { store, bytes } = setup();
    expect(store.put(cloud, tokens("same", "cloud-secret"))).toBe(true);
    expect(store.put(local, tokens("same", "local-secret"))).toBe(true);
    const rows = store.rows(local);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.active)).toEqual([false, true]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows.every((row) => row.avatarUrl === "https://cdn.example/avatar.png")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("secret");
    expect(bytes().toString()).not.toContain("cloud-secret");
    expect(store.current(cloud)?.refreshToken).toBe("cloud-secret");
  });
  it("retains each saved deployment's public runtime configuration", () => {
    const { store } = setup();
    const publicConfig = parseDesktopConfig({
      apiUrl: local.apiUrl, edition: "outpost", docSyncUrl: "wss://sync.example.com",
    })!.publicConfig;
    const target = { ...local, publicConfig };
    expect(store.put(target, tokens("one"))).toBe(true);
    expect(store.find(deploymentAccountKey({ target, tokens: tokens("one") }))?.target.publicConfig).toEqual(publicConfig);
    expect(deploymentKey(target)).toBe(deploymentKey(local));
  });
  it("keeps other accounts through rotation and active-account logout", () => {
    const { store } = setup();
    store.put(cloud, tokens("one"));
    store.put(cloud, tokens("two"));
    store.put(cloud, tokens("two", "rotated"));
    store.put(local, tokens("one"));
    store.remove(deploymentAccountKey({ target: cloud, tokens: tokens("two") }));
    expect(store.current(cloud)).toBeNull();
    expect(store.rows(local)).toHaveLength(2);
    expect(store.current(local)?.user?.id).toBe("one");
  });
  it("stores a refreshed candidate without selecting it before a successful window close", () => {
    const { store } = setup();
    store.put(cloud, tokens("one"));
    store.put(cloud, tokens("two", "rotated"), false);
    expect(store.current(cloud)?.user?.id).toBe("one");
    expect(store.find(deploymentAccountKey({ target: cloud, tokens: tokens("two") }))?.tokens.refreshToken).toBe("rotated");
  });
  it("fails closed without OS encryption or with an invalid endpoint", () => {
    const { store, bytes } = setup(false);
    expect(store.put(cloud, tokens("one"))).toBe(false);
    expect(bytes().length).toBe(0);
    expect(setup().store.put({ ...cloud, apiUrl: "https://user:password@api.example.com" }, tokens("one"))).toBe(false);
  });
  it("includes the API pairing and auth strategy in the deployment identity", () => {
    expect(deploymentKey(local)).not.toBe(deploymentKey({ ...local, apiUrl: "http://localhost:4001" }));
    expect(deploymentKey(local)).not.toBe(deploymentKey({ ...local, auth: "pkce" }));
    expect(deploymentKind(local)).toBe("local");
    expect(deploymentKind({ ...local, appUrl: "http://[::1]:3003" })).toBe("local");
    expect(deploymentKind({ ...local, appUrl: "https://brain.example.com" })).toBe("self-hosted");
  });
  it("drains pending work and returns a bounded failure while work remains", async () => {
    const operations = new TargetOperations();
    let finish!: () => void;
    const work = operations.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    expect(await operations.idle(5)).toBe(false);
    finish();
    await work;
    expect(await operations.idle()).toBe(true);
    await expect(operations.run(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(await operations.idle()).toBe(true);
  });
});
