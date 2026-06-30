// Copy the static assets that the TypeScript build doesn't emit — the sandboxed
// preload (`preload.cjs`) and the sign-in / offline landings (`signin.html`,
// `offline.html`) — from src/ into dist/. Run after `tsc` by the `build` / `dev`
// scripts.
//
// This replaces a Unix `cp` that broke the Windows build: npm/pnpm run scripts via
// cmd.exe on Windows, which has no `cp`, so `package:win` failed at the copy step
// on any Windows (CI or a build VM). `node` is cross-platform, so this works
// identically on macOS, Linux, and Windows. Paths resolve relative to this file,
// not the cwd, so it's robust regardless of where pnpm invokes it.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of ["preload.cjs", "signin.html", "offline.html"]) {
  copyFileSync(join(pkgRoot, "src", file), join(pkgRoot, "dist", file));
}
