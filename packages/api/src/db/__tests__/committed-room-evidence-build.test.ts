import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scripts = new URL('../../../scripts/conversation-store/', import.meta.url)
const { committedRoomEvidenceMigration } =
  await import(new URL('build-committed-room-evidence.mjs', scripts).href)
const { currentReleaseSource } = await import(new URL('installation-release.mjs', scripts).href)

describe('[COMP:api/native-turn-frame] committed room record recovery installation', () => {
  // Both checks independently render the full predecessor authentication chain.
  it('renders the exact migration and independently authenticates the installed private proof', async () => {
    execFileSync(process.execPath, [fileURLToPath(new URL('build-committed-room-evidence.mjs', scripts)), '--check'])
    const profile = await currentReleaseSource(committedRoomEvidenceMigration)
    expect(profile.functions).toBe(495)
    expect(profile.sql).toContain('installation_committed_room_evidence_changed')
  }, 15_000)
})
