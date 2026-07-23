import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { acquireChannelMedia } from '../channel-media-acquirer.js'

describe('[COMP:brain/channel-media-acquirer] acquisition storage routing', () => {
  it('streams with the byte cap into the supplied backend then runs intake', async () => {
    const chunks: Buffer[] = []
    const writeStream = vi.fn(() => {
      const stream = new PassThrough()
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      return stream
    })
    const createEpisode = vi.fn(async () => ({ id: 'rec-1' }) as never)
    const createRecording = vi.fn(async () => ({ id: 'rec-1' }) as never)
    const result = await acquireChannelMedia({
      source: { url: 'https://cdn.example/audio' },
      key: 'ws-1/channel-media/id',
      ref: {
        channel: 'discord',
        storageUri: 's3://bucket/ws-1/channel-media/id',
        mime: 'audio/ogg',
        fileName: 'memo.ogg',
        sender: { id: 'sender-1', name: null },
        workspaceId: 'ws-1',
        assistantId: 'assistant-1',
        actingUserId: 'owner-1',
      },
      storage: { writeStream, deleteBlob: vi.fn(async () => {}) },
      intakeDeps: {
        createEpisode,
        createRecording,
        enqueueRecordingJob: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })),
      },
      fetchFn: vi.fn(async () => new Response('audio-bytes', {
        headers: { 'content-type': 'audio/ogg', 'content-length': '11' },
      })) as typeof fetch,
    })

    expect(Buffer.concat(chunks).toString()).toBe('audio-bytes')
    expect(writeStream).toHaveBeenCalledWith('ws-1/channel-media/id', expect.objectContaining({ mime: 'audio/ogg' }))
    expect(createRecording).toHaveBeenCalledWith(expect.objectContaining({
      storageUri: 's3://bucket/ws-1/channel-media/id',
    }))
    expect(result).toEqual({ status: 'queued', kind: 'audio_video', recordingId: 'rec-1', jobId: 'job-1' })
  })

  it('deletes a document staging object after durable intake', async () => {
    const writeStream = vi.fn(() => new PassThrough())
    const deleteBlob = vi.fn(async () => {})
    const result = await acquireChannelMedia({
      source: { url: 'https://cdn.example/document' },
      key: 'ws-1/channel-media/document',
      ref: {
        channel: 'slack',
        mime: 'text/plain',
        fileName: 'notes.txt',
        sender: { id: 'sender-1', name: null },
        workspaceId: 'ws-1',
        assistantId: 'assistant-1',
        actingUserId: 'owner-1',
      },
      storage: { writeStream, deleteBlob },
      intakeDeps: {
        createEpisode: vi.fn(),
        createRecording: vi.fn(),
        enqueueRecordingJob: vi.fn(),
        ingestDocument: vi.fn(async () => ({ status: 'accepted' as const, episodeId: null, fileId: 'file-1', path: '/uploads/notes.txt' })),
      },
      fetchFn: vi.fn(async () => new Response('notes', {
        headers: { 'content-type': 'text/plain', 'content-length': '5' },
      })) as typeof fetch,
    })
    expect(result).toMatchObject({ status: 'ingested', kind: 'document' })
    expect(deleteBlob).toHaveBeenCalledWith('ws-1/channel-media/document')
  })
})
