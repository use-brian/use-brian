import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveOssGitCommitSha } from "./build-info.config";

/**
 * Desktop bundle build — "Approach B" of
 * docs/plans/canvas-desktop-bundled-offline.md.
 *
 * Produces a `file://`-loadable SPA of the doc client, emitted into the
 * Electron shell's `renderer/` dir (selected only by explicit
 * `USEBRIAN_BUNDLED=1` QA). This is SEPARATE from the Next build — Vite
 * only runs when this config is invoked (`pnpm --filter app-web build:desktop`),
 * so the web/SSR build is untouched. The SPA reuses app-web's own `@/`
 * components via the alias below; `next/*` get alias-shimmed (added as the doc
 * shell is mounted — see the plan's Phase 2).
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const ossGitCommitSha = resolveOssGitCommitSha();

export default defineConfig({
  define: {
    "process.env.NEXT_PUBLIC_OSS_GIT_COMMIT_SHA": JSON.stringify(ossGitCommitSha),
  },
  plugins: [
    react(),
    // Tailwind v4 (the Next build uses @tailwindcss/postcss; the Vite build needs
    // the Vite plugin). Processes `@import "tailwindcss"` in globals.css.
    tailwindcss(),
    {
      name: "reject-next-server-runtime",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === "chunk" && output.code.includes("next.rootSpanId")) {
            this.error("Next's server tracing runtime was included in the desktop renderer");
          }
        }
      },
    },
  ],
  root: resolve(here, "desktop"),
  // Relative asset URLs so the bundle resolves correctly from a file:// origin.
  base: "./",
  // `@tailwindcss/vite` owns Tailwind here; pin an empty inline PostCSS config so
  // Vite does NOT also auto-load the Next-oriented `postcss.config.mjs`
  // (`@tailwindcss/postcss`), which would double-process and error.
  css: { postcss: {} },
  resolve: {
    alias: {
      // Shim Next's client APIs onto react-router / DOM so app-web's
      // `"use client"` components run unmodified under Vite. Order: longer/more
      // specific specifiers first.
      "@/lib/i18n/set-locale": resolve(here, "desktop/shims/set-locale.ts"),
      "next/navigation": resolve(here, "desktop/shims/next-navigation.tsx"),
      "next/link": resolve(here, "desktop/shims/next-link.tsx"),
      "next/image": resolve(here, "desktop/shims/next-image.tsx"),
      "@": resolve(here, "src"),
    },
  },
  build: {
    outDir: resolve(here, "..", "app-desktop", "renderer"),
    emptyOutDir: true,
  },
});
