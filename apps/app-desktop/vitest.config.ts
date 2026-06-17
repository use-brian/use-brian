import { defineConfig } from "vitest/config";

// The desktop shell's pure helpers are node-only (no DOM); the Electron wiring
// in main.ts / menu.ts is verified manually, not under vitest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
