import { defineConfig } from 'vitest/config';
import { resolveCollabSingletonAliases } from '../../scripts/collab-singletons.mjs';

export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  resolve: { alias: resolveCollabSingletonAliases(import.meta.url) },
  test: {
    // Native externalization would bypass the canonical ESM aliases in peers.
    server: { deps: { inline: [/@tiptap\//, /prosemirror-/, /yjs/, /y-prosemirror/, /y-protocols/] } },
  },
});
