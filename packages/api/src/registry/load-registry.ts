import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  CommunityRegistrySchema,
  OFFICIAL_CONNECTORS,
  type ConnectorEntry,
} from '@sidanclaw/shared'

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
    console.warn('[registry] Failed to load community connectors:', (err as Error).message)
    return official
  }
}
