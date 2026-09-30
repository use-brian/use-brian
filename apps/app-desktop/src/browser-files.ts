import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DownloadItem } from "electron";

export const DOWNLOAD_LIMIT = 32 * 1024 * 1024;
export const UPLOAD_LIMIT = 4 * 1024 * 1024;
export const DOWNLOAD_CHUNK = 256 * 1024;
const SESSION_LIMIT = 128 * 1024 * 1024;

type Download = {
  id: string; name: string; mime: string; size: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  error?: string;
};
type Entry = { info: Download; path: string; item: DownloadItem; timer: ReturnType<typeof setTimeout> };

/** Display names never become local paths. All storage is private to one approved host. */
export function browserFileName(value: string): string {
  let name = value.replace(/[/\\:<>"|?*\x00-\x1f\x7f]/g, "_").slice(0, 200).replace(/[. ]+$/g, "");
  if (!name) return "file";
  const basename = name.split(".")[0]!.replace(/ +$/g, "");
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(basename)) name = `_${name}`;
  return name.slice(0, 200).replace(/[. ]+$/g, "");
}

export class BrowserFiles {
  private directory: string | null = null;
  private disposed = false;
  private entries = new Map<string, Entry>();
  private uploadBytes = 0;
  private uploadCount = 0;
  constructor(private readonly status: (message: string) => void) {}

  private root(): string {
    this.check();
    // mkdtemp creates a mode-0700 directory; generated paths cannot escape it.
    return this.directory ??= mkdtempSync(join(tmpdir(), "brian-browser-"));
  }
  private check(): void { if (this.disposed) throw new Error("Browser file session is closed"); }

  capture(item: DownloadItem): void {
    this.check();
    const reserved = [...this.entries.values()].reduce((sum, e) => sum + (e.info.state === "progressing" ? DOWNLOAD_LIMIT : e.info.size), this.uploadBytes);
    if (this.entries.size >= 20 || item.getTotalBytes() > DOWNLOAD_LIMIT || reserved + DOWNLOAD_LIMIT > SESSION_LIMIT) {
      item.cancel();
      this.status("Download blocked: maximum 32 MiB per file, 20 downloads and 128 MiB per browser session");
      return;
    }
    const id = randomUUID();
    const path = join(this.root(), id);
    const info: Download = { id, name: browserFileName(item.getFilename()), mime: item.getMimeType().slice(0, 200), size: 0, state: "progressing" };
    const fail = (message: string) => {
      if (info.state !== "progressing") return;
      info.state = "cancelled";
      info.error = message;
      info.size = 0;
      clearTimeout(entry.timer);
      item.cancel();
      void rm(path, { force: true }).catch(() => {});
      this.status(message);
    };
    const entry: Entry = { info, path, item, timer: setTimeout(() => fail("Download timed out after 2 minutes"), 120_000) };
    this.entries.set(id, entry);
    item.setSavePath(path); // No Save dialog; never use a website-supplied path.
    item.on("updated", (_event, state) => {
      if (this.disposed || info.state !== "progressing") return;
      info.size = item.getReceivedBytes();
      if (info.size > DOWNLOAD_LIMIT) { fail("Download exceeded the 32 MiB limit"); return; }
      if (state === "interrupted") fail("Download interrupted; retry the webpage download");
    });
    item.once("done", (_event, state) => {
      clearTimeout(entry.timer);
      if (this.disposed || info.state !== "progressing") {
        void rm(path, { force: true }).catch(() => {});
        return;
      }
      info.size = item.getReceivedBytes();
      if (info.size > DOWNLOAD_LIMIT) { fail("Download exceeded the 32 MiB limit"); return; }
      info.state = state;
      if (state !== "completed") {
        info.error = "Download did not complete; retry the webpage download";
        void rm(path, { force: true }).catch(() => {});
      }
      this.status(state === "completed" ? `Downloaded ${info.name}. Brian can read it using browserReadDownload; temporary files are removed when this browser closes.` : info.error!);
    });
    this.status(`Downloading ${info.name}…`);
  }

  list(): { downloads: Download[] } {
    this.check();
    return { downloads: [...this.entries.values()].map(e => ({ ...e.info })) };
  }

  async read(id: string, offset: unknown): Promise<{ data: string; offset: number; total: number }> {
    this.check();
    const entry = this.entries.get(id);
    if (!entry || entry.info.state !== "completed") throw new Error("Download is unknown or not completed in this browser session");
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.info.size) throw new Error("Invalid download offset");
    const file = await open(entry.path, "r");
    try {
      this.check();
      const stat = await file.stat();
      if (stat.size !== entry.info.size || stat.size > DOWNLOAD_LIMIT) throw new Error("Download size changed");
      const buffer = Buffer.alloc(Math.min(DOWNLOAD_CHUNK, stat.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      this.check();
      return { data: buffer.subarray(0, bytesRead).toString("base64"), offset, total: stat.size };
    } finally { await file.close(); }
  }

  async stageUpload(name: string, data: string): Promise<string> {
    this.check();
    if (!name || name.length > 200 || name !== browserFileName(name)) throw new Error("Invalid upload filename");
    if (data.length > Math.ceil(UPLOAD_LIMIT / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) throw new Error("Invalid or oversized upload (maximum 4 MiB)");
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data || bytes.length > UPLOAD_LIMIT) throw new Error("Invalid or oversized upload");
    const reserved = [...this.entries.values()].reduce((sum, e) => sum + (e.info.state === "progressing" ? DOWNLOAD_LIMIT : e.info.size), this.uploadBytes);
    if (this.uploadCount >= 20 || reserved + bytes.length > SESSION_LIMIT) throw new Error("Browser file session quota exceeded");
    // A separate generated directory preserves the selected filename without collisions.
    const directory = mkdtempSync(join(this.root(), "upload-"));
    const path = join(directory, name);
    this.uploadBytes += bytes.length;
    this.uploadCount++;
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      this.check();
      return path;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      this.uploadBytes -= bytes.length;
      this.uploadCount--;
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      if (entry.info.state === "progressing") entry.item.cancel();
    }
    this.entries.clear();
    if (this.directory) void rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}
