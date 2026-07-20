import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

// Default `pnpm test` runs UNIT tests only (root CLAUDE.md test table).
// Core's integration suites (`*.integration.test.ts`) hit live LLM
// providers and are gated on their API-key env vars; they run via
// `vitest.integration.config.ts`. Excluding them here keeps the default
// run unit-only and consistent with @use-brian/api.
export default defineConfig({
  server: {
    fs: {
      // When this repo is consumed as a submodule of the hosted platform
      // (workspace absorption), deps link into the SUPERPROJECT's .pnpm
      // store — one level above this repo's own workspace root, outside
      // vite's default fs.allow boundary. Inlined ESM deps (pptxgenjs)
      // then fail to load with "Cannot find module". Allow three levels
      // up (superproject root in absorbed mode; harmless standalone).
      allow: [fileURLToPath(new URL('../../..', import.meta.url))],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
})
