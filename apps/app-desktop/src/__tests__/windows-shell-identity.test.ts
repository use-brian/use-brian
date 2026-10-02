import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { APP_ID, windowsAppUserModelId } from "../app-identity.js";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => any };
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url));
const builder = yaml.load(read("electron-builder.yml").toString("utf8")) as { appId: string; win: { icon: string } };

/** Windows scale-factor sizes: 16/24/32/48 at 100-200%, the taskbar's 24 -> 30/36/48, plus 256. */
const SHELL_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256];
const CYAN = [0, 229, 255, 255];

type Entry = { size: number; png: boolean; pixel: (x: number, y: number) => number[] };

function icoEntries(file: Buffer): Entry[] {
  expect([file.readUInt16LE(0), file.readUInt16LE(2)]).toEqual([0, 1]);
  return Array.from({ length: file.readUInt16LE(4) }, (_, index) => {
    const at = 6 + index * 16;
    const size = file[at] || 256;
    const data = file.subarray(file.readUInt32LE(at + 12), file.readUInt32LE(at + 12) + file.readUInt32LE(at + 8));
    const png = data.readUInt32BE(0) === 0x89504e47;
    // 32-bit DIB: 40-byte header, then BGRA rows stored bottom-up.
    const pixel = (x: number, y: number) => {
      const o = 40 + ((size - 1 - y) * size + x) * 4;
      return [data[o + 2], data[o + 1], data[o], data[o + 3]];
    };
    return { size, png, pixel };
  });
}

describe("[COMP:app-desktop/windows-shell-identity] Windows taskbar identity and icon", () => {
  it("restates the installer's appId, which NSIS stamps on the shortcuts", () => {
    expect(APP_ID).toBe(builder.appId);
  });

  it("claims the id only for a packaged Windows run", () => {
    expect(windowsAppUserModelId("win32", true)).toBe(APP_ID);
    expect(windowsAppUserModelId("win32", false)).toBeNull();
    expect(windowsAppUserModelId("darwin", true)).toBeNull();
    expect(windowsAppUserModelId("linux", true)).toBeNull();
  });

  it("claims it in main before the single-instance lock and any window", () => {
    const main = read("src/main.ts").toString("utf8");
    const claim = main.indexOf("app.setAppUserModelId(");
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(main.indexOf("app.requestSingleInstanceLock()"));
    expect(claim).toBeLessThan(main.indexOf("app.whenReady()"));
  });

  it("builds from the committed multi-size icon, not a conversion of icon.png", () => {
    expect(builder.win.icon).toBe("build/icon.ico");
    expect(icoEntries(read(builder.win.icon)).map((entry) => entry.size)).toEqual(SHELL_SIZES);
  });

  // The master's grid seams alias into stray dark lines once Windows shrinks
  // them, so no entry may carry one: the mark's body is a single flat fill.
  it.each(SHELL_SIZES.filter((size) => size < 256))("draws the %ipx mark without grid seams", (size) => {
    const entry = icoEntries(read(builder.win.icon)).find((candidate) => candidate.size === size)!;
    expect(entry.png).toBe(false);
    const cyanRuns = (line: number[][]) => line.filter((pixel, i) =>
      String(pixel) === String(CYAN) && String(line[i - 1]) !== String(CYAN)).length;
    const axis = Array.from({ length: size }, (_, i) => i);
    // Just below the centre line: the full-width row under the eyes.
    expect(cyanRuns(axis.map((x) => entry.pixel(x, size / 2 + 1)))).toBe(1);
    // Just left of the centre line: the middle column, top row to the leg gap.
    expect(cyanRuns(axis.map((y) => entry.pixel(size / 2 - 1, y)))).toBe(1);
    // Centred: the bitmap is its own mirror image.
    for (const y of axis) {
      expect(axis.map((x) => entry.pixel(x, y))).toEqual(axis.map((x) => entry.pixel(size - 1 - x, y)));
    }
  });
});
