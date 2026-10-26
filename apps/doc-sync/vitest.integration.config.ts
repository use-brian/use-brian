import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveCollabSingletonAliases } from '../../scripts/collab-singletons.mjs';

// DB-backed suites (`*.integration.test.ts`). They run only through
// scripts/crm/local-fixture.mjs, which provides the disposable PostgreSQL 18
// database; the unit config (vitest.config.ts) excludes them so `pnpm test`
// never needs one. Resolution matches the unit config.
export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  // Absorbed (submodule-of-platform) mode resolves some packages from the
  // superproject's pnpm store, one level above this repository.
  server: { fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } },
  resolve: { alias: resolveCollabSingletonAliases(new URL('../../packages/doc-model/package.json', import.meta.url)) },
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: { deps: { inline: [/@use-brian\/doc-model/, /@hocuspocus\/server/, /@tiptap\//, /prosemirror-/, /yjs/, /y-prosemirror/, /y-protocols/] } },
  },
});
