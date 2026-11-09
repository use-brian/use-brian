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
const presentationSchema = z.object({
  displayName: z.string().trim().max(80),
  icon: z.string().trim().max(128 * 1024).refine((value) => value === "" ||
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    (value.length <= 32 &&
      /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u{E0020}-\u{E007F}0-9#*\u20E3]+$/u.test(value) &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(value))),
}).strict();
const entrySchema = z.object({ target: targetSchema, tokens: tokensSchema, presentation: presentationSchema.optional() });
const storeSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema), active: z.record(z.string()), order: z.array(z.string()).optional() });
export type AccountTarget = { kind: TargetKind; appUrl: string; apiUrl: string; auth: TargetAuth; publicConfig?: DesktopPublicConfig | null };
export type SavedDeploymentAccount = z.infer<typeof entrySchema>;
export type DeploymentAccountSnapshot = Readonly<{
  entries: readonly SavedDeploymentAccount[]
  active: Readonly<Record<string, string>>
}>;
type AccountStore = z.infer<typeof storeSchema>;
export type DeploymentAccountRow = {
  displayName?: string; icon?: string;
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

function sameStoredTokens(a: StoredTokens, b: StoredTokens): boolean {
  return a.accessToken === b.accessToken
    && a.refreshToken === b.refreshToken
    && a.accessTokenExpiresAt === b.accessTokenExpiresAt
    && (a.user?.id ?? "") === (b.user?.id ?? "")
    && (a.user?.name ?? "") === (b.user?.name ?? "")
    && (a.user?.email ?? "") === (b.user?.email ?? "")
    && (a.user?.avatarUrl ?? null) === (b.user?.avatarUrl ?? null)
    && (a.user?.plan ?? undefined) === (b.user?.plan ?? undefined);
}

/** All disk I/O is injected; credentials are encrypted before a write. */
export class DeploymentAccounts {
  /** Last decrypted directory, keyed by the exact bytes returned from disk. */
  private memory: { source: Buffer; store: AccountStore } | null = null;
  constructor(private readonly cipher: TokenCipher, private readonly read: () => Buffer, private readonly write: (blob: Buffer) => void) {}
  /**
   * Decrypt a given file image once. A second reader of the same file sees a
   * new image after a write and parses that, so the cache cannot hide another
   * instance's update.
   */
  private load(): AccountStore {
    let blob: Buffer;
    try { blob = this.read(); } catch { return empty(); }
    if (!Buffer.isBuffer(blob) || blob.length === 0) return empty();
    if (this.memory?.source.equals(blob)) return this.memory.store;
    try {
      if (!this.cipher.isAvailable()) return empty();
      const parsed = storeSchema.safeParse(JSON.parse(this.cipher.decryptString(blob)));
      if (!parsed.success) return empty();
      this.memory = { source: Buffer.from(blob), store: parsed.data };
      return parsed.data;
    } catch { return empty(); }
  }
  private save(store: AccountStore): boolean {
    try {
      const parsed = storeSchema.parse(store);
      const plain = JSON.stringify(parsed);
      const blob = encryptBlob(this.cipher, plain);
      if (!blob) return false;
      this.write(blob);
      const written = this.read();
      if (this.cipher.decryptString(written) !== plain) {
        this.memory = null;
        return false;
      }
      this.memory = { source: Buffer.from(written), store: parsed };
      return true;
    } catch {
      return false;
    }
  }
  /** Mutate a copy. A failed write leaves the cached directory unchanged. */
  private change(edit: (store: AccountStore) => boolean): boolean {
    const store = structuredClone(this.load());
    if (!edit(store)) return false;
    return this.save(store);
  }
  current(target: AccountTarget): StoredTokens | null {
    const store = this.load();
    const key = store.active[deploymentKey(target)];
    const tokens = store.entries.find((entry) => deploymentKey(entry.target) === deploymentKey(target) && deploymentAccountKey(entry) === key)?.tokens ?? null;
    return tokens ? structuredClone(tokens) : null;
  }
  find(key: string): SavedDeploymentAccount | null {
    const entry = this.load().entries.find((saved) => deploymentAccountKey(saved) === key) ?? null;
    return entry ? structuredClone(entry) : null;
  }
  /** Credential-bearing snapshot for pure main-process routing only. */
  snapshot(): DeploymentAccountSnapshot {
    const store = this.load();
    return { entries: structuredClone(store.entries), active: { ...store.active } };
  }
  put(target: AccountTarget, tokens: StoredTokens, activate = true): boolean {
    return this.change((store) => {
      const entry = { target, tokens };
      const key = deploymentAccountKey(entry);
      const index = store.entries.findIndex((saved) => deploymentAccountKey(saved) === key);
      if (index === -1) store.entries.push(entry);
      else store.entries[index] = { ...store.entries[index], ...entry };
      if (activate) store.active[deploymentKey(target)] = key;
      return true;
    });
  }
  /**
   * Upsert sessions discovered while listing the picker. Returns false without
   * touching disk when every session and the requested active account already match.
   */
  syncListedSessions(target: AccountTarget, listed: ReadonlyArray<{ tokens: StoredTokens; activate: boolean }>): boolean {
    if (!this.listedSessionsDiffer(target, listed)) return false;
    return this.change((store) => {
      for (const item of listed) this.applyListedSession(store, target, item);
      return true;
    });
  }
  private listedSessionsDiffer(target: AccountTarget, listed: ReadonlyArray<{ tokens: StoredTokens; activate: boolean }>): boolean {
    const store = this.load();
    const activeKey = deploymentKey(target);
    return listed.some((item) => {
      const key = deploymentAccountKey({ target, tokens: item.tokens });
      const saved = store.entries.find((entry) => deploymentAccountKey(entry) === key);
      if (!saved || !sameStoredTokens(saved.tokens, item.tokens)) return true;
      return item.activate && store.active[activeKey] !== key;
    });
  }
  private applyListedSession(store: AccountStore, target: AccountTarget, item: { tokens: StoredTokens; activate: boolean }): void {
    const entry = { target, tokens: item.tokens };
    const key = deploymentAccountKey(entry);
    const index = store.entries.findIndex((saved) => deploymentAccountKey(saved) === key);
    if (index === -1) store.entries.push(entry);
    else if (!sameStoredTokens(store.entries[index].tokens, item.tokens)) {
      store.entries[index] = { ...store.entries[index], tokens: item.tokens };
    }
    if (item.activate) store.active[deploymentKey(target)] = key;
  }
  remove(key: string): boolean {
    return this.change((store) => {
      store.entries = store.entries.filter((entry) => deploymentAccountKey(entry) !== key);
      if (store.order) store.order = store.order.filter((saved) => saved !== key);
      for (const [target, active] of Object.entries(store.active)) {
        if (active === key) delete store.active[target];
      }
      return true;
    });
  }
  updatePresentation(key: string, input: unknown): boolean {
    const presentation = presentationSchema.safeParse(input);
    if (!presentation.success) return false;
    return this.change((store) => {
      const entry = store.entries.find((saved) => deploymentAccountKey(saved) === key);
      if (!entry) return false;
      entry.presentation = presentation.data;
      return true;
    });
  }
  private orderedEntries(store: AccountStore): SavedDeploymentAccount[] {
    const ranks = new Map(store.order?.map((key, index) => [key, index]));
    return [...store.entries].sort((a, b) => store.order
      ? (ranks.get(deploymentAccountKey(a)) ?? ranks.size) - (ranks.get(deploymentAccountKey(b)) ?? ranks.size)
      : Number(b.target.kind === "cloud") - Number(a.target.kind === "cloud"));
  }
  move(key: string, direction: unknown): boolean {
    if (direction !== "up" && direction !== "down") return false;
    return this.change((store) => {
      const order = this.orderedEntries(store).map(deploymentAccountKey);
      const index = order.indexOf(key);
      const next = index + (direction === "up" ? -1 : 1);
      if (index < 0 || next < 0 || next >= order.length) return false;
      [order[index], order[next]] = [order[next], order[index]];
      store.order = order;
      return true;
    });
  }
  rows(target: AccountTarget): DeploymentAccountRow[] {
    const store = this.load();
    const currentKey = store.active[deploymentKey(target)];
    return this.orderedEntries(store).map((entry) => {
      const key = deploymentAccountKey(entry);
      return { ...entry.presentation, key, id: entry.tokens.user?.id ?? "", name: entry.tokens.user?.name ?? "",
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
