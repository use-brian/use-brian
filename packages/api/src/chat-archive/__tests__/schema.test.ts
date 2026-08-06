import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../migrations/395_chat_message_archive.sql', import.meta.url),
  'utf8',
)

describe('[COMP:integrations/chat-message-archive-schema] chat archive schema', () => {
  it('owns the durable message, search, coverage, and backfill relations in one PGLite-compatible migration', () => {
    expect(migration).toContain('CREATE TABLE chat_archive_messages')
    expect(migration).toContain('CREATE TABLE chat_archive_segments')
    expect(migration).toContain('CREATE TABLE chat_archive_coverage_windows')
    expect(migration).toContain('CREATE TABLE chat_archive_backfill_runs')
    expect(migration).toContain('\nBEGIN;')
    expect(migration).toMatch(/COMMIT;\s*$/)
  })
})
