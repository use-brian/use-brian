// Documentation-only previews. Imports production components without changing them.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const app = resolve(repo, "apps/app-web");
const require = createRequire(resolve(app, "package.json"));
const { defineConfig } = await import(pathToFileURL(require.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
const { default: tailwind } = await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href);
const reactRoot = dirname(require.resolve("react/package.json"));
const domRoot = dirname(require.resolve("react-dom/package.json"));

export default defineConfig({
  root: here,
  // Client-only fixture configuration. Never load the repository's .env here.
  define: { "process.env": {} },
  plugins: [react(), tailwind()],
  css: { postcss: {} },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: require.resolve("react") },
      { find: /^react\//, replacement: `${reactRoot}/` },
      { find: /^react-dom$/, replacement: require.resolve("react-dom") },
      { find: /^react-dom\//, replacement: `${domRoot}/` },
      { find: "next/navigation", replacement: resolve(app, "desktop/shims/next-navigation.tsx") },
      { find: "next/link", replacement: resolve(app, "desktop/shims/next-link.tsx") },
      { find: "@", replacement: resolve(app, "src") },
    ],
  },
  server: { host: "127.0.0.1", port: 3210, strictPort: true, fs: { allow: [repo] } },
});
