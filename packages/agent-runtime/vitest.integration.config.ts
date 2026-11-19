import { defineConfig } from 'vitest/config'

// `pnpm test:integration`: the runtime's provider integration suites. Each
// suite self-skips when its required API-key env var is absent (see
// docs/workflow/testing.md), so this config only scopes the run.
export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
