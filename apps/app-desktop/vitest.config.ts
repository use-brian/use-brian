import { defineConfig } from "vitest/config";

// The desktop shell's pure helpers are node-only (no DOM); the Electron wiring
// in main.ts / menu.ts is verified manually, not under vitest.
export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Release and packaging coverage launches many real subprocesses. Running
    // those files in parallel with the rest of the desktop suite can starve
    // Vitest's worker RPC on a shared CI runner even when all assertions pass.
    fileParallelism: process.env.CI !== "true",
  },
});
