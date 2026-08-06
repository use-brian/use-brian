/** Extract chat media into derived archive segments, then let embeddings drain normally. */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { RecordingTranscriber } from '@use-brian/core'
import { parseFileContent } from '@use-brian/core'
import type { ChatArchiveMediaAsset, ChatArchiveMediaStore, DerivedMediaSegment } from '../db/chat-archive-media-store.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { extractRecordingAudio, probeRecordingDuration } from '../recordings/ffmpeg.js'

const execFileAsync = promisify(execFile)
const MAX_VIDEO_FRAMES = 120
const MAX_SEGMENT_CHARS = 1_800
const SEGMENT_OVERLAP_CHARS = 200
const MAX_DERIVED_SEGMENTS = 400

const PARSEABLE_DOCUMENT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const LEGACY_OR_UNKNOWN_MIMES = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/octet-stream',
])

function chunks(text: string, metadata: Record<string, unknown>): DerivedMediaSegment[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  const out: DerivedMediaSegment[] = []
  let offset = 0
  while (offset < clean.length && out.length < MAX_DERIVED_SEGMENTS) {
    let end = Math.min(clean.length, offset + MAX_SEGMENT_CHARS)
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf(' ', end))
      if (boundary > offset + Math.floor(MAX_SEGMENT_CHARS / 2)) end = boundary
    }
    out.push({ text: clean.slice(offset, end), metadata: { ...metadata, chunk: out.length } })
    if (end >= clean.length) break
    offset = Math.max(offset + 1, end - SEGMENT_OVERLAP_CHARS)
  }
  return out
}

async function decodeWechatSilk(
  data: Buffer,
  decoderBin = process.env.WECHAT_SILK_DECODER_BIN?.trim() || 'silk_v3_decoder',
): Promise<{ buffer: Buffer; mime: string; durationMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-silk-'))
  const input = join(dir, 'input.silk')
  const pcm = join(dir, 'output.pcm')
  const output = join(dir, 'output.m4a')
  try {
    await writeFile(input, data)
    try {
      await execFileAsync(decoderBin, [input, pcm, '-quiet'], { timeout: 120_000, maxBuffer: 1 << 20 })
    } catch (err) {
      throw new Error(`WeChat SILK decoder prerequisite failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm,
      '-ar', '16000', '-c:a', 'aac', '-b:a', '24k', output,
    ], { timeout: 120_000, maxBuffer: 1 << 20 })
    const durationMs = await probeRecordingDuration(output)
    return { buffer: await readFile(output), mime: 'audio/mp4', durationMs }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function sampleVideoFrames(input: string): Promise<Array<{ data: Buffer; timeStartMs: number }>> {
  const dir = await mkdtemp(join(tmpdir(), 'chat-video-'))
  try {
    const pattern = join(dir, 'frame-%03d.jpg')
    const filter = [
      'select=gt(scene\\,0.30)+isnan(prev_selected_t)+gte(t-prev_selected_t\\,10)',
      'mpdecimate',
      "scale='min(1280,iw)':-2",
      'showinfo',
    ].join(',')
    const { stderr } = await execFileAsync('ffmpeg', [
      '-v', 'info', '-y', '-i', input, '-vf', filter, '-vsync', 'vfr',
      '-frames:v', String(MAX_VIDEO_FRAMES), '-q:v', '3', pattern,
    ], { timeout: 900_000, maxBuffer: 8 << 20 })
    const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Math.round(Number(match[1]) * 1000))
    const files = (await readdir(dir)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort()
    return Promise.all(files.slice(0, MAX_VIDEO_FRAMES).map(async (name, index) => ({
      data: await readFile(join(dir, name)),
      timeStartMs: Number.isFinite(times[index]) ? times[index]! : index * 10_000,
    })))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function transcribeAsset(input: {
  asset: ChatArchiveMediaAsset
  signedUrl: string
  storage: Awaited<ReturnType<FilesClientResolver['forUri']>>
  transcriber?: RecordingTranscriber
  modality?: 'audio_transcript' | 'video_transcript'
  language?: string
  probe?: typeof probeRecordingDuration
  extract?: typeof extractRecordingAudio
}): Promise<DerivedMediaSegment[]> {
  if (!input.transcriber) throw new Error('chat archive media transcription prerequisite missing')
  let audio: { buffer: Buffer; mime: string }
  let durationMs: number
  if (input.asset.mime === 'audio/silk' || input.asset.filename.toLowerCase().endsWith('.silk')) {
    const blob = await input.storage.readBlob(input.asset.storageKey)
    if (!blob) throw new Error('chat archive SILK media bytes are missing')
    const decoded = await decodeWechatSilk(blob.bytes)
    audio = decoded
    durationMs = decoded.durationMs
  } else {
    durationMs = await (input.probe ?? probeRecordingDuration)(input.signedUrl)
    if (durationMs > 180 * 60 * 1000) throw new Error('chat archive media exceeds the 180 minute limit')
    audio = await (input.extract ?? extractRecordingAudio)(input.signedUrl)
  }
  if (durationMs > 180 * 60 * 1000) throw new Error('chat archive media exceeds the 180 minute limit')

  const stagedKey = `${input.asset.storageKey}.transcription.m4a`
  await input.storage.writeBlob(stagedKey, audio.buffer, {
    workspaceId: input.asset.workspaceId,
    createdByUserId: input.asset.ownerUserId,
    mime: audio.mime,
  })
  try {
    const sourceUrl = await input.storage.signedReadUrl(stagedKey, 3600)
    const result = await input.transcriber.transcribe({
      buffer: audio.buffer,
      mime: audio.mime,
      durationMs,
      sourceUrl,
      displayName: input.asset.filename || basename(input.asset.storageKey),
      ...(input.language ? { language: input.language } : {}),
    })
    return result.utterances.flatMap((utterance, index) => {
      const text = `${utterance.speaker ? `${utterance.speaker}: ` : ''}${utterance.text}`.trim()
      return text ? [{
        text,
        metadata: {
          modality: input.modality ?? 'audio_transcript',
          utterance: index,
          time_start_ms: utterance.startMs,
          time_end_ms: utterance.endMs,
          ...(utterance.speaker ? { speaker: utterance.speaker } : {}),
        },
      }] : []
    })
  } finally {
    await input.storage.deleteBlob(stagedKey).catch(() => {})
  }
}

export type ChatArchiveMediaWorker = {
  runOnce(): Promise<boolean>
  cleanupOnce(): Promise<number>
  start(): void
  stop(): void
}

export function createChatArchiveMediaWorker(deps: {
  store: ChatArchiveMediaStore
  filesResolver: FilesClientResolver
  transcriber?: RecordingTranscriber
  distill?: (input: { buffer: Buffer; mime: string; prompt?: string }) => Promise<string>
  resolveTranscriptionLanguage?: (workspaceId: string) => Promise<string | undefined>
  probe?: typeof probeRecordingDuration
  extract?: typeof extractRecordingAudio
  intervalMs?: number
  cleanupAgeMs?: number
}): ChatArchiveMediaWorker {
  const intervalMs = deps.intervalMs ?? 15_000
  const cleanupAgeMs = deps.cleanupAgeMs ?? 24 * 60 * 60 * 1000
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function derive(asset: ChatArchiveMediaAsset): Promise<DerivedMediaSegment[] | 'unsupported'> {
    const storage = await deps.filesResolver.forUri(asset.workspaceId, asset.storageUri)
    const signedUrl = await storage.signedReadUrl(asset.storageKey, 3600)

    if (asset.kind === 'image') {
      if (!deps.distill) throw new Error('chat archive image distillation prerequisite missing')
      const blob = await storage.readBlob(asset.storageKey)
      if (!blob) throw new Error('chat archive image bytes are missing')
      const [ocr, description] = await Promise.all([
        deps.distill({
          buffer: blob.bytes,
          mime: asset.mime,
          prompt: 'Transcribe every visible word in this image faithfully. Preserve reading order. Return only the transcription.',
        }),
        deps.distill({
          buffer: blob.bytes,
          mime: asset.mime,
          prompt: 'Describe the meaningful visual content of this image for semantic search, including people, objects, setting, actions, charts, and notable details. Do not invent hidden facts.',
        }),
      ])
      return [
        ...chunks(ocr, { modality: 'image_ocr' }),
        ...chunks(description, { modality: 'image_description' }),
      ]
    }

    if (asset.kind === 'voice') {
      return transcribeAsset({
        asset,
        signedUrl,
        storage,
        transcriber: deps.transcriber,
        language: await deps.resolveTranscriptionLanguage?.(asset.workspaceId),
        probe: deps.probe,
        extract: deps.extract,
      })
    }

    if (asset.kind === 'video') {
      const durationMs = await probeRecordingDuration(signedUrl)
      if (durationMs > 180 * 60 * 1000) throw new Error('chat archive media exceeds the 180 minute limit')
      const segments: DerivedMediaSegment[] = []
      try {
        segments.push(...await transcribeAsset({
          asset,
          signedUrl,
          storage,
          transcriber: deps.transcriber,
          modality: 'video_transcript',
          language: await deps.resolveTranscriptionLanguage?.(asset.workspaceId),
          probe: deps.probe,
          extract: deps.extract,
        }))
      } catch (err) {
        console.warn('[chat-archive-media] video audio track unavailable:', err instanceof Error ? err.message : err)
      }
      if (!deps.distill) throw new Error('chat archive video vision prerequisite missing')
      const frames = await sampleVideoFrames(signedUrl)
      for (const frame of frames) {
        const description = (await deps.distill({
          buffer: frame.data,
          mime: 'image/jpeg',
          prompt: 'Describe this sampled video frame for semantic search. Include visible people, objects, setting, actions, text, and other concrete details. Do not invent context.',
        })).trim()
        if (description) {
          segments.push({
            text: description,
            metadata: {
              modality: 'video_frame',
              time_start_ms: frame.timeStartMs,
              time_end_ms: Math.min(durationMs, frame.timeStartMs + 10_000),
            },
          })
        }
      }
      if (segments.length === 0) throw new Error('chat archive video produced no transcript or visual description')
      return segments
    }

    if (LEGACY_OR_UNKNOWN_MIMES.has(asset.mime)) return 'unsupported'
    const blob = await storage.readBlob(asset.storageKey)
    if (!blob) throw new Error('chat archive document bytes are missing')
    if (asset.mime === 'application/pdf') {
      if (!deps.distill) throw new Error('chat archive PDF distillation prerequisite missing')
      return chunks(
        await deps.distill({ buffer: blob.bytes, mime: asset.mime }),
        { modality: 'document', page: null },
      )
    }
    if (!asset.mime.startsWith('text/') && !PARSEABLE_DOCUMENT_MIMES.has(asset.mime)) return 'unsupported'
    if (asset.mime === 'application/xml' || asset.mime === 'application/yaml') {
      return chunks(blob.bytes.toString('utf8'), { modality: 'document', page: null })
    }
    const parsed = await parseFileContent(blob.bytes, asset.mime, asset.filename)
    return chunks(parsed.text, { modality: 'document', page: null })
  }

  const runOnce = async (): Promise<boolean> => {
    if (running) return false
    running = true
    let job: Awaited<ReturnType<ChatArchiveMediaStore['claimNext']>> = null
    try {
      job = await deps.store.claimNext()
      if (!job) return false
      const derived = await derive(job.asset)
      if (derived === 'unsupported') {
        await deps.store.unsupportedJob(job.id, job.asset.id, `unsupported media extraction format: ${job.asset.mime}`)
        return true
      }
      await deps.store.replaceDerivedSegments(job.asset, derived)
      await deps.store.completeJob(job.id, job.asset.id)
      return true
    } catch (err) {
      if (job) {
        await deps.store.failJob(
          job.id,
          job.asset.id,
          job.attemptCount,
          err instanceof Error ? err.message : String(err),
        ).catch(() => {})
      }
      console.warn('[chat-archive-media] processing failed:', err)
      return false
    } finally {
      running = false
    }
  }

  const cleanupOnce = async (): Promise<number> => {
    const assets = await deps.store.listUnlinkedBefore(new Date(Date.now() - cleanupAgeMs))
    let removed = 0
    for (const asset of assets) {
      try {
        await deps.store.remove(asset.id)
      } catch (err) {
        console.warn('[chat-archive-media] orphan cleanup failed:', err)
      }
    }
    const deletions = await deps.store.listDeletions()
    for (const deletion of deletions) {
      try {
        const storage = await deps.filesResolver.forUri(deletion.workspaceId, deletion.storageUri)
        await storage.deleteBlob(deletion.storageKey)
        await deps.store.completeDeletion(deletion.id)
        removed += 1
      } catch (err) {
        await deps.store.failDeletion(
          deletion.id,
          deletion.attemptCount,
          err instanceof Error ? err.message : String(err),
        ).catch(() => {})
        console.warn('[chat-archive-media] byte deletion failed:', err)
      }
    }
    return removed
  }

  return {
    runOnce,
    cleanupOnce,
    start() {
      if (timer) return
      timer = setInterval(() => {
        void runOnce()
        void cleanupOnce()
      }, intervalMs)
      timer.unref?.()
      void runOnce()
      void cleanupOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
