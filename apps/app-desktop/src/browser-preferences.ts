import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const schema = z.object({ browserEnabled: z.boolean() });

/** Device-wide browser opt-out. No credentials or profile data are stored here.
 * [COMP:app-desktop/embedded-browser] */
export class BrowserPreferences {
  private cached: boolean | undefined;
  constructor(private readonly filename: () => string) {}

  enabled(): boolean {
    if (this.cached !== undefined) return this.cached;
    try {
      this.cached = schema.parse(JSON.parse(readFileSync(this.filename(), "utf8"))).browserEnabled;
    } catch (error) {
      // Only first use defaults on. A damaged/unreadable opt-out must not enable access.
      this.cached = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    return this.cached;
  }

  setEnabled(value: unknown): void {
    const settings = schema.parse({ browserEnabled: value });
    const file = this.filename();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(settings), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.cached = settings.browserEnabled;
  }
}
