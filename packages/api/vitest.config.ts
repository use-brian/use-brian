import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

// Default `pnpm test` runs UNIT tests only — see the test table in the
// root CLAUDE.md (`pnpm test` = unit, `pnpm test:integration` =
// integration). Integration suites (`*.integration.test.ts`) need a live
// Postgres reached through the shared `getPool()` (which reads
// DATABASE_URL); they run via `vitest.integration.config.ts`. Excluding
// them here keeps a bare `pnpm test` green on a machine with no
// DATABASE_URL set.
export default defineConfig({
  server: {
    fs: {
      // Same superproject-store allowance as packages/core/vitest.config.ts:
      // in absorbed (submodule-of-platform) mode, inlined ESM deps reached
      // through @use-brian/core (pptxgenjs) resolve into the superproject's
      // .pnpm store one level above this repo's workspace root, which
      // vite's default fs.allow boundary rejects. Harmless standalone.
      allow: [fileURLToPath(new URL('../../..', import.meta.url))],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
})
