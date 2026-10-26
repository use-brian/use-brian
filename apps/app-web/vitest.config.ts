import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { resolveCollabSingletonAliases } from "../../scripts/collab-singletons.mjs";

const collabSingletonAliases = resolveCollabSingletonAliases(import.meta.url);

/**
 * Pure logic and jsdom component tests. Match the browser's constructor
 * identities without externalizing React peers into another pnpm store.
 */
export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  // Next's PostCSS plugin-string format is not a Vite plugin object. Unit
  // tests don't need Tailwind generation when a lazy component imports CSS.
  css: { postcss: { plugins: [] } },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      ...collabSingletonAliases,
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Optimize the actual subpath imports, not only the unused package barrel.
    // This also routes CJS hook shims through React dedupe instead of Node.
    deps: {
      optimizer: {
        web: {
          enabled: true,
          include: [
            "react", "react-dom", "react-dom/client", "lucide-react",
            ...["dialog", "alert-dialog", "button", "popover", "tooltip", "menu",
              "combobox", "select", "checkbox", "switch"].map(name => `@base-ui/react/${name}`),
            ...["jotai", "jotai-scope", "@radix-ui/react-popover", "@radix-ui/react-tabs", "tunnel-rat"]
              .map(name => `@excalidraw/excalidraw > ${name}`),
          ],
        },
      },
    },
    // Keep the SDK's extensionless roughjs imports working without browser-
    // bundling its native Node dependencies. Collaboration peers use ESM aliases.
    server: { deps: { inline: [/@excalidraw\/excalidraw/, /roughjs/,
      /@tiptap\//, /prosemirror-/, /yjs/, /y-prosemirror/, /y-protocols/,
      /@hocuspocus\//] } },
    // Shims `localStorage` for Node 26+ (its experimental built-in is undefined
    // without --localstorage-file and shadows jsdom's). See vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
  },
});
