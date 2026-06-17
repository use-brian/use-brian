import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest for apps/app-web. Scoped to pure-logic unit tests (no DOM)
 * — the `@/` alias mirrors the tsconfig path so `@/`-imported modules
 * resolve.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
