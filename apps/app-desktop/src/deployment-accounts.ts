/** Deployment-scoped saved sessions. [COMP:app-desktop/deployment-accounts]
 * Spec: docs/architecture/features/app-desktop.md -> One account picker across deployments.
 */
import { z } from "zod";
import { encryptBlob, type StoredTokens, type TokenCipher } from "./desktop-token-store.js";
import { parseDesktopConfig, type DesktopPublicConfig, type TargetAuth, type TargetKind } from "./target-store.js";

const url = z.string().url().refine((value) => {
  const parsed = new URL(value);
  return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
});
const targetSchema = z.object({
  kind: z.enum(["cloud", "local"]), appUrl: url, apiUrl: url,
  auth: z.enum(["pkce", "local-session"]),
  publicConfig: z.unknown().transform((value) => parseDesktopConfig(value)?.publicConfig ?? null).optional(),
});
const tokensSchema = z.object({
  accessToken: z.string().min(1), refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.number().finite(),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    avatarUrl: z.string().url().nullable().optional(),
    plan: z.string().optional(),
  }).optional(),
});
const entrySchema = z.object({ target: targetSchema, tokens: tokensSchema });
const storeSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema), active: z.record(z.string()) });
export type AccountTarget = { kind: TargetKind; appUrl: string; apiUrl: string; auth: TargetAuth; publicConfig?: DesktopPublicConfig | null };
export type SavedDeploymentAccount = z.infer<typeof entrySchema>;
export type DeploymentAccountSnapshot = Readonly<{
  entries: readonly SavedDeploymentAccount[]
  active: Readonly<Record<string, string>>
}>;
type AccountStore = z.infer<typeof storeSchema>;
export type DeploymentAccountRow = {
  key: string; id: string; name: string; email: string; avatarUrl?: string | null;
  deployment: "cloud" | "local" | "self-hosted"; appUrl: string; active: boolean;
};
const empty = (): AccountStore => ({ version: 1, entries: [], active: {} });
export function deploymentKey(target: AccountTarget): string {
  return JSON.stringify([target.kind, target.appUrl.replace(/\/+$/, ""), target.apiUrl.replace(/\/+$/, ""), target.auth]);
}
export function deploymentAccountKey(entry: SavedDeploymentAccount): string {
  return JSON.stringify([deploymentKey(entry.target), entry.tokens.user?.id ?? ""]);
}
export function deploymentKind(target: AccountTarget): DeploymentAccountRow["deployment"] {
  if (target.kind === "cloud") return "cloud";
  const host = new URL(target.appUrl).hostname;
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\./.test(host)
    ? "local" : "self-hosted";
}

/** All disk I/O is injected; credentials are encrypted before a write. */
export class DeploymentAccounts {
  constructor(private readonly cipher: TokenCipher, private readonly read: () => Buffer, private readonly write: (blob: Buffer) => void) {}
  private load(): AccountStore {
    try {
      if (!this.cipher.isAvailable()) return empty();
      const parsed = storeSchema.safeParse(JSON.parse(this.cipher.decryptString(this.read())));
      return parsed.success ? parsed.data : empty();
    } catch { return empty(); }
  }
  private save(store: AccountStore): boolean {
    try {
      const plain = JSON.stringify(storeSchema.parse(store));
      const blob = encryptBlob(this.cipher, plain);
      if (!blob) return false;
      this.write(blob);
      return this.cipher.decryptString(this.read()) === plain;
    } catch { return false; }
  }
  current(target: AccountTarget): StoredTokens | null {
    const store = this.load();
    const key = store.active[deploymentKey(target)];
    return store.entries.find((entry) => deploymentKey(entry.target) === deploymentKey(target) && deploymentAccountKey(entry) === key)?.tokens ?? null;
  }
  find(key: string): SavedDeploymentAccount | null {
    return this.load().entries.find((entry) => deploymentAccountKey(entry) === key) ?? null;
  }
  /** Credential-bearing snapshot for pure main-process routing only. */
  snapshot(): DeploymentAccountSnapshot {
    const store = this.load();
    return { entries: store.entries, active: store.active };
  }
  put(target: AccountTarget, tokens: StoredTokens, activate = true): boolean {
    const store = this.load();
    const entry = { target, tokens };
    const key = deploymentAccountKey(entry);
    store.entries = store.entries.filter((saved) => deploymentAccountKey(saved) !== key);
    store.entries.push(entry);
    if (activate) store.active[deploymentKey(target)] = key;
    return this.save(store);
  }
  remove(key: string): boolean {
    const store = this.load();
    store.entries = store.entries.filter((entry) => deploymentAccountKey(entry) !== key);
    for (const [target, active] of Object.entries(store.active)) {
      if (active === key) delete store.active[target];
    }
    return this.save(store);
  }
  rows(target: AccountTarget): DeploymentAccountRow[] {
    const store = this.load();
    const currentKey = store.active[deploymentKey(target)];
    return store.entries.map((entry) => {
      const key = deploymentAccountKey(entry);
      return { key, id: entry.tokens.user?.id ?? "", name: entry.tokens.user?.name ?? "",
        email: entry.tokens.user?.email ?? "", avatarUrl: entry.tokens.user?.avatarUrl,
        appUrl: entry.target.appUrl,
        deployment: deploymentKind(entry.target), active: key === currentKey };
    });
  }
}

/** A config change waits for old-target async work, including nested work. */
export class TargetOperations {
  private pending = new Set<Promise<unknown>>();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = work();
    this.pending.add(result);
    void result.then(() => this.pending.delete(result), () => this.pending.delete(result));
    return result;
  }
  async idle(timeoutMs = 15_000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const drain = async (): Promise<true> => {
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      return true;
    };
    try { return await Promise.race([drain(), timeout]); }
    finally { clearTimeout(timer); }
  }
}
