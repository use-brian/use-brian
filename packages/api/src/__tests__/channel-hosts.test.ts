import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { buildOpenChannelHosts } from '../channel-hosts.js'
import type { BootContext } from '../boot.js'

const acquireChannelMedia = vi.hoisted(() => vi.fn(async () => ({
  status: 'queued' as const,
  kind: 'audio_video' as const,
  recordingId: 'rec-1',
  jobId: 'job-1',
})))
vi.mock('../ingest/channel-media-acquirer.js', () => ({ acquireChannelMedia }))

vi.mock('../ingest/channel-media-deps.js', () => ({
  createOpenChannelMediaIntakeDeps: vi.fn(() => ({
    createEpisode: vi.fn(async () => ({ id: 'rec-1' })),
    createRecording: vi.fn(async () => ({ id: 'rec-1' })),
    enqueueRecordingJob: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })),
  })),
}))

describe('[COMP:channels/open-host-factory] buildOpenChannelHosts', () => {
  it('provides Slack, Discord, and Telegram media hosts over the boot resolver', async () => {
    const writeStream = vi.fn(() => new PassThrough())
    const forWorkspace = vi.fn(async () => ({
      gcs: { writeStream },
      bucket: 'local-root',
      uriScheme: 'file' as const,
      byo: true,
    }))
    const hosts = buildOpenChannelHosts({
      filesResolver: { forWorkspace, forUri: vi.fn() },
      filesApi: null,
      brainEpisodeIngestor: vi.fn(),
    } as unknown as BootContext)

    expect(hosts.slackIngestChannelMediaRef).toBeTypeOf('function')
    expect(hosts.discordIngestChannelMediaRef).toBeTypeOf('function')
    expect(hosts.telegramIngestChannelMediaRef).toBeTypeOf('function')

    await hosts.slackIngestChannelMediaRef!({
      source: { url: 'https://files.example/memo.ogg' },
      mime: 'audio/ogg',
      fileName: 'memo.ogg',
      sizeBytes: 12,
      sender: { id: 'sender-1', name: null },
      conversationId: 'channel-1',
      workspaceId: 'ws-1',
      assistantId: 'assistant-1',
      actingUserId: 'owner-1',
    })
    expect(forWorkspace).toHaveBeenCalledWith('ws-1')
    expect(acquireChannelMedia).toHaveBeenCalledWith(expect.objectContaining({
      storage: expect.objectContaining({ writeStream }),
      ref: expect.objectContaining({
        channel: 'slack',
        storageUri: expect.stringMatching(/^file:\/\/local-root\/ws-1\/channel-media\//),
      }),
    }))
  })

  it('leaves only media hooks unwired when storage is unavailable', () => {
    expect(buildOpenChannelHosts({ filesResolver: null } as BootContext)).toEqual({})
  })
})
