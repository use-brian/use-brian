import { configDefaults, defineConfig } from 'vitest/config'

// Default `pnpm test` runs UNIT tests only (root CLAUDE.md test table).
// Core's integration suites (`*.integration.test.ts`) hit live LLM
// providers and are gated on their API-key env vars; they run via
// `vitest.integration.config.ts`. Excluding them here keeps the default
// run unit-only and consistent with @sidanclaw/api.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
})
