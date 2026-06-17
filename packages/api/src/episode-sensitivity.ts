/**
 * Sensitivity-tier mapping — OPEN, pure.
 *
 * Collapses a core 3-tier `Sensitivity` (`public` / `internal` / `confidential`)
 * to the Episode store's `EpisodeSensitivity` (`public` / `internal` / `private`).
 * Relocated out of the closed `ingest/pipeline-b-processor.ts` so the OPEN
 * brain-MCP ingest path can reuse it without importing closed code.
 */
import type { Sensitivity } from '@sidanclaw/core'
import type { EpisodeSensitivity } from './db/episodes-store.js'

export function toEpisodeSensitivity(s: Sensitivity): EpisodeSensitivity {
  switch (s) {
    case 'public':
      return 'public'
    case 'internal':
      return 'internal'
    case 'confidential':
      return 'private'
  }
}
