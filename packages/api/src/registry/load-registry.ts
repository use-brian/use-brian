import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  CommunityRegistrySchema,
  OFFICIAL_CONNECTORS,
  type ConnectorEntry,
} from '@use-brian/shared'

const TOOLS_DIR = resolve(
  import.meta.dirname, '..', '..', '..', '..', 'sidanclaw-tools',
)

/**
 * Load the connector registry: official connectors + community connectors
 * from sidanclaw-tools/connectors/<name>/connector.json. Called once at server boot.
 */
export function loadConnectorRegistry(): ConnectorEntry[] {
  const official = OFFICIAL_CONNECTORS

  try {
    const connectorsDir = join(TOOLS_DIR, 'connectors')
    const dirs = readdirSync(connectorsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())

    const community: ConnectorEntry[] = []
    for (const dir of dirs) {
      try {
        const raw = readFileSync(join(connectorsDir, dir.name, 'connector.json'), 'utf-8')
        const parsed = JSON.parse(raw)
        // Validate with the community schema (single entry)
        const validated = CommunityRegistrySchema.parse({ connectors: [parsed] })
        community.push({
          ...validated.connectors[0],
          category: 'community',
          oauth_required: false,
          enabled: true,
        })
      } catch {
        // Skip malformed entries
      }
    }

    console.log(`[registry] Loaded ${community.length} community connector(s)`)
    return [...official, ...community]
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // A clean open-source clone has no sidanclaw-tools submodule, so the
    // connectors dir is simply absent (ENOENT). That is the expected default,
    // not a fault — populate it with `git submodule update --init sidanclaw-tools`
    // to load community connectors. Any other error is a real problem worth a warn.
    if (e.code === 'ENOENT') {
      console.log('[registry] No community connectors (sidanclaw-tools not present)')
    } else {
      console.warn('[registry] Failed to load community connectors:', e.message)
    }
    return official
  }
}
