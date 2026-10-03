// Copy the static assets that the TypeScript build doesn't emit — the sandboxed
// preloads (`preload.cjs`, `pet-preload.cjs`) and the bundled HTML surfaces —
// from src/ into dist/. Run after `tsc` by the `build` / `dev` scripts.
//
// This replaces a Unix `cp` that broke the Windows build: npm/pnpm run scripts via
// cmd.exe on Windows, which has no `cp`, so `package:win` failed at the copy step
// on any Windows (CI or a build VM). `node` is cross-platform, so this works
// identically on macOS, Linux, and Windows. Paths resolve relative to this file,
// not the cwd, so it's robust regardless of where pnpm invokes it.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [
  "preload.cjs",
  "pet-preload.cjs",
  "embedded-browser-preload.cjs",
  "embedded-browser.html",
  "signin.html",
  "offline.html",
  "brian-pet.html",
]) {
  copyFileSync(join(pkgRoot, "src", file), join(pkgRoot, "dist", file));
}

// The companion displays the canonical transparent app mark, not a reconstructed SVG.
copyFileSync(join(pkgRoot, "..", "app-web", "public", "icon.png"), join(pkgRoot, "dist", "brian-logo.png"));

// buildResources are installer inputs, not shipped runtime files. Keep tray
// assets under dist/** so packaged apps and development load the same images.
mkdirSync(join(pkgRoot, "dist", "tray"), { recursive: true });
for (const file of ["icon.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
  copyFileSync(join(pkgRoot, "build", file), join(pkgRoot, "dist", "tray", file));
}
