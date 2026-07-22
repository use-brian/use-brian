import { describe, expect, it } from "vitest";
import {
  buildStoredZip,
  buildTeamsAppPackage,
  buildTeamsManifest,
  crc32,
  type ZipEntry,
} from "../teams-app-package";

// Minimal central-directory reader used to verify the builder's output.
function listEntries(zip: Uint8Array): Array<{ name: string; data: Uint8Array; crc: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocdAt = zip.byteLength - 22;
  expect(view.getUint32(eocdAt, true)).toBe(0x06054b50);
  const count = view.getUint16(eocdAt + 10, true);
  let pos = view.getUint32(eocdAt + 16, true);
  const decoder = new TextDecoder();
  const entries: Array<{ name: string; data: Uint8Array; crc: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50);
    expect(view.getUint16(pos + 10, true)).toBe(0); // method: stored
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const localAt = view.getUint32(pos + 42, true);
    const name = decoder.decode(zip.subarray(pos + 46, pos + 46 + nameLen));
    expect(view.getUint32(localAt, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localAt + 26, true);
    const dataAt = localAt + 30 + localNameLen;
    entries.push({ name, data: zip.subarray(dataAt, dataAt + size), crc });
    pos += 46 + nameLen;
  }
  return entries;
}

describe("[COMP:app-web/teams-app-package] Teams app package builder", () => {
  it("crc32 matches the standard test vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("builds a stored zip that round-trips entry bytes with valid CRCs", () => {
    const binary = new Uint8Array([0, 1, 2, 250, 255, 137, 80, 78, 71]);
    const input: ZipEntry[] = [
      { name: "manifest.json", data: new TextEncoder().encode('{"a":1}') },
      { name: "color.png", data: binary },
      { name: "outline.png", data: new Uint8Array(0) },
    ];
    const zip = buildStoredZip(input);
    const entries = listEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["manifest.json", "color.png", "outline.png"]);
    for (const [i, entry] of entries.entries()) {
      expect(Array.from(entry.data)).toEqual(Array.from(input[i].data));
      expect(entry.crc).toBe(crc32(input[i].data));
    }
  });

  it("fills the manifest bot id, trimming input, with icon filenames at the zip root", () => {
    const manifest = buildTeamsManifest("  abc-123  ") as {
      id: string;
      icons: { color: string; outline: string };
      bots: Array<{ botId: string }>;
    };
    expect(manifest.id).toBe("abc-123");
    expect(manifest.bots[0].botId).toBe("abc-123");
    expect(manifest.icons).toEqual({ color: "color.png", outline: "outline.png" });
  });

  it("falls back to a placeholder bot id when the App ID is empty", () => {
    const manifest = buildTeamsManifest("") as { id: string };
    expect(manifest.id).toBe("<AZURE_BOT_APP_ID>");
  });

  it("packages manifest.json + both icons into one zip", () => {
    const color = new Uint8Array([1, 2, 3]);
    const outline = new Uint8Array([4, 5]);
    const zip = buildTeamsAppPackage("bot-id", color, outline);
    const entries = listEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["manifest.json", "color.png", "outline.png"]);
    const manifest = JSON.parse(new TextDecoder().decode(entries[0].data)) as {
      id: string;
    };
    expect(manifest.id).toBe("bot-id");
  });
});
