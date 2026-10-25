import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
