import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Native-only standing consent, keyed by the hashed account/relay/profile partition.
 * Never stores tokens, website credentials, or grants access to manual tabs.
 */
export class BrowserApprovals {
  constructor(private readonly filename: () => string) {}
  private read(): Set<string> {
    try {
      const value: unknown = JSON.parse(readFileSync(this.filename(), "utf8"));
      return new Set(Array.isArray(value) ? value.filter((key): key is string =>
        typeof key === "string" && /^persist:embedded-browser-[a-f0-9]{64}$/.test(key)) : []);
    } catch { return new Set(); }
  }
  has(partition: string): boolean { return this.read().has(partition); }
  grant(partition: string): void {
    const grants = this.read();
    grants.add(partition);
    try {
      const file = this.filename();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify([...grants]), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch { /* If persistence is unavailable, ask for consent next time. */ }
  }
}
