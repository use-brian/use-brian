import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// `pnpm test:integration` — the DB-backed suites. They exercise the real
// store SQL against a live Postgres reached through the shared
// `getPool()` (client.ts), which reads DATABASE_URL. Default it to the
// local dev database so the suites connect out of the box; an explicit
// DATABASE_URL (CI, a remote DB) still wins. Each suite additionally
// self-skips via its own `canConnect()` guard when no DB is reachable.
process.env.DATABASE_URL ??= 'postgres:///sidanclaw'

export default defineConfig({
  server: {
    fs: {
      // Match the unit-test config in absorbed (submodule-of-platform) mode:
      // inlined ESM dependencies can resolve into the superproject's pnpm
      // store one level above this repo's workspace root.
      allow: [fileURLToPath(new URL('../../..', import.meta.url))],
    },
  },
  test: {
    include: ['src/**/*.integration.test.ts'],
    // A few suites (e.g. provenance, proactive-compaction) run multi-second
    // real-DB flows; give them headroom over the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
