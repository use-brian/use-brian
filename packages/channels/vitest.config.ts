import { configDefaults, defineConfig } from 'vitest/config'

// Default `pnpm test` runs UNIT tests only (root CLAUDE.md test table).
// The WeChat iLink suite (`*.integration.test.ts`) hits the live iLink API
// and is gated on its scratch-bot env vars; it runs via
// `vitest.integration.config.ts`. Excluding it here keeps the default run
// unit-only and consistent with @use-brian/core and @use-brian/api.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
})
