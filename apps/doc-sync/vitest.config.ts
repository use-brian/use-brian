import { configDefaults, defineConfig } from 'vitest/config';
import { resolveCollabSingletonAliases } from '../../scripts/collab-singletons.mjs';

export default defineConfig({
  resolve: { alias: resolveCollabSingletonAliases(new URL('../../packages/doc-model/package.json', import.meta.url)) },
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    server: { deps: { inline: [/@use-brian\/doc-model/, /@hocuspocus\/server/, /@tiptap\//, /prosemirror-/, /yjs/, /y-prosemirror/, /y-protocols/] } },
  },
});
