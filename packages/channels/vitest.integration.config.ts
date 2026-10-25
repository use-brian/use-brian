import { defineConfig } from 'vitest/config'

// `pnpm test:integration` — the live iLink (WeChat) suite. It self-skips
// when the scratch-bot env vars are absent (see docs/workflow/testing.md),
// so this config just scopes the run to the integration files; no secrets
// are injected here.
export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
