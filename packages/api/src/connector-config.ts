/**
 * Connector app-credential config — the OPEN seam for built-in OAuth connectors.
 *
 * Why this exists: `mcp/inject.ts` is OPEN (it injects the generic
 * `mcp_search`/`mcp_call` tools) but also carries the built-in Google/Notion/
 * Fathom connector injectors, which need OAuth *app* credentials. Reading those
 * via `getEnv()` would couple the open module to the closed env schema
 * (`@use-brian/shared-server`). Instead they come through `getConnectorConfig`,
 * which resolves credentials from an optional, user-owned JSON file and falls
 * back to `process.env` so the hosted platform (creds in env) is unchanged.
 *
 * Resolution order per provider:
 *   1. `~/.usebrian/connectors.config.json` (legacy `~/.sidanclaw/` fallback; override path: `CONNECTORS_CONFIG_PATH`)
 *   2. `process.env.<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`
 *   3. undefined  → the connector injector no-ops (connector-less boot)
 *
 * The open single-player product boots connector-less by default (no file, no
 * env). See the open-core split (repo CLAUDE.md; plan in git history) §12.2 / §12.7.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export type ConnectorProvider = 'google' | 'notion' | 'fathom'

export type ConnectorAppConfig = {
  clientId: string
  clientSecret: string
}

const appConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
})

const fileSchema = z
  .object({
    google: appConfigSchema.optional(),
    notion: appConfigSchema.optional(),
    fathom: appConfigSchema.optional(),
  })
  .partial()

type FileConfig = z.infer<typeof fileSchema>

let _fileConfig: FileConfig | null = null

/** Load + memoize the optional connectors.config.json. Missing/invalid → {}. */
function loadConnectorConfig(): FileConfig {
  if (_fileConfig) return _fileConfig
  // Canonical dotdir first; legacy `~/.sidanclaw/` fallback covers a
  // standalone API run against a not-yet-migrated install (the launcher
  // renames the whole dir on boot — see scripts/launch.mjs).
  const candidates = process.env.CONNECTORS_CONFIG_PATH
    ? [process.env.CONNECTORS_CONFIG_PATH]
    : [
        join(homedir(), '.usebrian', 'connectors.config.json'),
        join(homedir(), '.sidanclaw', 'connectors.config.json'),
      ]
  _fileConfig = {}
  for (const path of candidates) {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      _fileConfig = parsed.success ? parsed.data : {}
      break
    } catch {
      // Absent (the default for the open product) or unreadable → try next.
    }
  }
  return _fileConfig
}

const ENV_KEYS: Record<ConnectorProvider, { id: string; secret: string }> = {
  google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  notion: { id: 'NOTION_CLIENT_ID', secret: 'NOTION_CLIENT_SECRET' },
  fathom: { id: 'FATHOM_CLIENT_ID', secret: 'FATHOM_CLIENT_SECRET' },
}

/**
 * Resolve a built-in connector's app credentials: file first, then env vars
 * (hosted), else undefined (connector-less). Not memoized at the provider level
 * so a test or the platform can mutate `process.env` between calls.
 */
export function getConnectorConfig(provider: ConnectorProvider): ConnectorAppConfig | undefined {
  const fromFile = loadConnectorConfig()[provider]
  if (fromFile) return fromFile
  const keys = ENV_KEYS[provider]
  const clientId = process.env[keys.id]
  const clientSecret = process.env[keys.secret]
  if (clientId && clientSecret) return { clientId, clientSecret }
  return undefined
}

/** Test seam: drop the memoized file config (so a test fixture path re-reads). */
export function _resetConnectorConfigCache(): void {
  _fileConfig = null
}
