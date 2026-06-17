import { configDefaults, defineConfig } from 'vitest/config'

// Default `pnpm test` runs UNIT tests only — see the test table in the
// root CLAUDE.md (`pnpm test` = unit, `pnpm test:integration` =
// integration). Integration suites (`*.integration.test.ts`) need a live
// Postgres reached through the shared `getPool()` (which reads
// DATABASE_URL); they run via `vitest.integration.config.ts`. Excluding
// them here keeps a bare `pnpm test` green on a machine with no
// DATABASE_URL set.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
})
