import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const scripts = new URL('../../../scripts/conversation-store/', import.meta.url)
const { buildCommittedRoomEvidenceMigration, committedRoomEvidenceMigration } =
  await import(new URL('build-committed-room-evidence.mjs', scripts).href)
const { currentReleaseSource } = await import(new URL('installation-release.mjs', scripts).href)

describe('[COMP:api/native-turn-frame] committed room record recovery installation', () => {
  it('renders the exact migration and independently authenticates the installed private proof', async () => {
    const [installed, source, profile] = await Promise.all([
      readFile(new URL('../../../migrations/' + committedRoomEvidenceMigration, import.meta.url), 'utf8'),
      buildCommittedRoomEvidenceMigration(),
      currentReleaseSource(committedRoomEvidenceMigration),
    ])
    expect(source).toBe(installed)
    expect(profile.functions).toBe(495)
    expect(profile.sql).toContain('installation_committed_room_evidence_changed')
  })
})
