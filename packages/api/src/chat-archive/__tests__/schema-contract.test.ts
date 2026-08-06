import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function migration(name: string): Promise<string> {
  return readFile(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8')
}

describe('[COMP:integrations/chat-message-archive-schema] archive migration contract', () => {
  it('keeps the archive migrations ordered and the raw message row immutable', async () => {
    const [base, sink, enrichment, cascade, media] = await Promise.all([
      migration('405_chat_message_archive.sql'),
      migration('406_local_chat_archive_sink.sql'),
      migration('407_chat_archive_enrichment.sql'),
      migration('408_chat_archive_owner_cascade.sql'),
      migration('409_chat_archive_media.sql'),
    ])

    expect(base).toContain('CREATE TABLE chat_archive_messages')
    expect(base).toContain('CREATE TABLE chat_archive_segments')
    expect(sink).toContain("managed_by = 'local_chat_archive'")
    expect(enrichment).toContain('CREATE TABLE chat_archive_enrichment_windows')
    expect(cascade).toContain('ON DELETE CASCADE')
    expect(media).toContain('CREATE TABLE chat_archive_media_assets')
    expect(media).toContain('CREATE TABLE chat_archive_media_jobs')
    expect(media).toContain('CREATE TABLE chat_archive_media_deletions')
    expect(media).not.toMatch(/ALTER TABLE chat_archive_messages[\s\S]*ADD COLUMN[\s\S]*(ocr|transcript|description)/i)
  })
})
