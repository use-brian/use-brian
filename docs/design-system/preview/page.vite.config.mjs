// Separate server keeps synthetic route transport out of isolated-component previews.
import config from "./vite.config.mjs";
import { fileURLToPath } from "node:url";
import { resolveCollabSingletonAliases } from "../../../scripts/collab-singletons.mjs";
const transport = fileURLToPath(new URL("./page-transport.tsx", import.meta.url));
export default {
  ...config,
  resolve: { ...config.resolve, alias: [
    { find: "@/lib/auth-fetch", replacement: transport },
    { find: "./auth-fetch", replacement: transport },
    { find: "@/components/doc/doc-sidebar-data", replacement: transport },
    ...config.resolve.alias,
    ...Object.entries(resolveCollabSingletonAliases(new URL("../../../apps/app-web/package.json", import.meta.url))).map(([find, replacement]) => ({ find, replacement })),
  ] },
  server: { ...config.server, port: 3211 },
};
