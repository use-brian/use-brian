# @sidanclaw/shared

Cross-package utilities and pure registries shared across apps + packages.
**Read this first when entering this package.** Project-wide rules in the root
`CLAUDE.md`.

## Layout

```
packages/shared/src/
├── env.ts                   # zod-validated getEnv() singleton (SERVER-ONLY — reads process.env)
├── builtin-connectors.ts    # OFFICIAL_CONNECTOR_TOOLS / OFFICIAL_OAUTH_SCOPES / BOOT_INJECTED_BUILTIN_TOOLS
├── connector-registry.ts    # OFFICIAL_CONNECTORS + ConnectorEntry schema
├── mini-apps.ts             # MINI_APPS registry (pure data; strings live in i18n)
├── app-types.ts             # AppType + assistant-kind constants
├── tool-display-names.ts    # friendly tool labels
├── control-tags.ts, follow-ups.ts, emoji-reactions.ts
├── doc-theme/            # theme token builder
├── index.ts                 # PUBLIC / client-safe barrel — does NOT re-export env.js
└── index.server.ts          # SERVER superset — re-exports ./index.js + ./env.js
```

## Subpath exports — `env.js` lives only on the `/server` barrel

`package.json` declares an `exports` map, not just a barrel. The split is
**load-bearing for the OSS extraction** (`docs/plans/oss-local-brain-wedge.md`
§10/§12.5): the open package must ship no secrets, so `env.ts` is reachable
**only** through the server superset barrel.

- The `"."` entry (`index.ts`) is the **client-safe public surface** — pure
  registries + utils, **no `env.js`**. Safe in any bundle.
- The `"./server"` entry (`index.server.ts`) re-exports the full public barrel
  **plus** `env.js` (`getEnv()` / `Env`). Server consumers (`apps/api`,
  `apps/api-admin`, the closed platform route/store modules) import `getEnv`
  from `@sidanclaw/shared/server`. **Never import `/server` from client bundles
  or from any OPEN package** (`packages/core` stays env-pure). In Phase B of the
  extraction, `index.server.ts` + `env.ts` are the pieces excluded from the
  `sidanclaw` submodule's exports map.

| Import | What it gives | Safe in client bundle |
|---|---|---|
| `@sidanclaw/shared` (barrel) | pure registries + utils, **no `getEnv()`** | **Yes** (env-free since the split) |
| `@sidanclaw/shared/server` | the barrel **plus** `getEnv()` / `Env` | **No** — pulls in `env.js` (server-only) |
| `@sidanclaw/shared/builtin-connectors` | `OFFICIAL_CONNECTOR_TOOLS`, `OFFICIAL_OAUTH_SCOPES`, types | Yes (no runtime imports) |
| `@sidanclaw/shared/connector-registry` | `OFFICIAL_CONNECTORS`, `ConnectorEntry` | Yes (imports only `zod`) |
| `@sidanclaw/shared/mini-apps` | `MINI_APPS` + helpers | Yes (no runtime imports) |

Consumers resolve the **built `dist/*`** (there is no `transpilePackages` in the
Next apps), so a `tsc` build of this package must precede a consumer typecheck —
Turborepo's `^build` dependency handles that. **When you add a new client-safe
module, add its subpath to the `exports` map** (and only after confirming it has
no transitive `env.js` import). Adding a new connector still means touching every
list in the "Adding a new built-in connector tool" checklist
(`docs/architecture/integrations/mcp.md`) — the registries here are the single
source of truth; never re-mirror them in an app.

## `env.ts` — the env singleton

`getEnv()` returns a typed, validated environment object. It's a **singleton**: parses `process.env` on first call, caches the result for the lifetime of the process.

```typescript
const _env: Env | null = null   // module-level cache

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env)   // throws on missing required vars
  }
  return _env
}
```

The schema lists every env var the project knows about. The full catalog (what each one is for) is mirrored in `docs/architecture/platform/deployment.md`. Keep that doc in sync when you add a var.

## The test-isolation gotcha

Because `_env` is module-level, **tests that need different env values for different cases** can't just `process.env.X = 'foo'` between cases — `getEnv()` won't re-read. The cache survives across tests in the same process.

Workarounds, in order of preference:

1. **Don't depend on `getEnv()` from the unit under test.** Take the value as a parameter instead. This is the cleanest fix and is how `packages/core` is structured (no module reads env directly — the API layer reads env once and passes it down).
2. **Re-import the module** after mutating `process.env` — `await import('@sidanclaw/shared/server')` after `vi.resetModules()` and a `process.env.X = 'foo'` mutation (`getEnv` lives on the `/server` barrel since the public/server split).
3. **Spy/mock the schema** with `vi.mock('@sidanclaw/shared/server')`.

The first option is what's actually used in the codebase. If you find yourself wanting options 2 or 3, that's a hint that the unit under test is doing too much. Refactor it to take the env value as a parameter.

## Conventions

- **Never log env values.** Even in error messages. The validation error formatter only includes the path and the zod issue, never the value.
- **Optional vars use the `optStr` / `optUrl` zod helpers** at the top of `env.ts` — they convert empty strings to `undefined` (a common `.env` quirk where unset vars become `""` rather than missing).
- **Required vars throw on first call** if missing. This is by design — the process should fail fast at startup, not silently 500 on the first request.

## Adding a new shared utility

Cross-package utilities go here only when **two or more packages need them**. If only one package uses it, it belongs in that package. Don't pre-emptively hoist things into shared.
