import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
import { unitTestExclusions } from '../../scripts/testing/unit-partition.mjs'

// Default `pnpm test` runs UNIT tests only, matching packages/core: the
// provider integration suites (`*.integration.test.ts`) hit live LLM
// providers, self-skip without their API-key env vars, and run through
// `vitest.integration.config.ts`.
export default defineConfig({
  // Synthetic tests use explicit environment only; never discover workspace dotenv.
  envDir: false,
  server: {
    fs: {
      // Same superproject-store allowance as packages/core/vitest.config.ts:
      // in absorbed (submodule-of-platform) mode deps link into the
      // superproject's .pnpm store, outside vite's default fs.allow boundary.
      allow: [fileURLToPath(new URL('../../..', import.meta.url))],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts', ...unitTestExclusions('packages/agent-runtime')],
  },
})
