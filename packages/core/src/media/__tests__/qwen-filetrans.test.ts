import { describe, it, expect, vi } from 'vitest'
import {
  qwenFiletransTranscriber,
  QWEN_FILETRANS_USD_PER_AUDIO_HOUR,
} from '../qwen-filetrans.js'

function mockResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

const HOUR_MS = 3_600_000
const REQ = {
  buffer: Buffer.from('unused'),
  mime: 'audio/aac',
  durationMs: HOUR_MS,
  sourceUrl: 'https://storage.example.com/signed/recording.m4a',
}

/** Sequence the fetch mock: submit → polls → result-file fetch. */
function scriptedFetch(responses: Array<(url: string, init?: RequestInit) => Response>) {
  let call = 0
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    const responder = responses[Math.min(call, responses.length - 1)]
    call++
    return responder(u, init)
  })
  return { fetchFn: fetchFn as unknown as typeof fetch, calls }
}

describe('[COMP:media/transcriber-qwen] qwenFiletransTranscriber', () => {
  it('submits async by URL, polls to SUCCEEDED, fetches the result file, maps ms sentences', async () => {
    const { fetchFn, calls } = scriptedFetch([
      () => mockResponse({ output: { task_id: 'task-1', task_status: 'PENDING' } }),
      () => mockResponse({ output: { task_status: 'RUNNING' } }),
      () =>
        mockResponse({
          output: {
            task_status: 'SUCCEEDED',
            result: { transcription_url: 'https://results.example.com/t.json' },
          },
        }),
      () =>
        mockResponse({
          transcripts: [
            {
              sentences: [
                { begin_time: 4000, end_time: 9000, text: '之後我哋 launch 個 product' },
                { begin_time: 0, end_time: 3500, text: '今日開會' },
                { begin_time: 3_500_000, end_time: HOUR_MS - 20_000, text: 'wrap up' },
              ],
            },
          ],
        }),
    ])

    const t = qwenFiletransTranscriber({ apiKey: 'ds-key', pollIntervalMs: 0, fetchFn })
    expect(t.name).toBe('dashscope:qwen3-asr-flash-filetrans')
    const res = await t.transcribe(REQ)

    // Submit call shape.
    expect(calls[0].url).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/asr/transcription',
    )
    const submitHeaders = calls[0].init?.headers as Record<string, string>
    expect(submitHeaders.Authorization).toBe('Bearer ds-key')
    expect(submitHeaders['X-DashScope-Async']).toBe('enable')
    const submitBody = JSON.parse(calls[0].init!.body as string)
    expect(submitBody.model).toBe('qwen3-asr-flash-filetrans')
    expect(submitBody.input.file_url).toBe(REQ.sourceUrl)
    expect(submitBody.parameters.enable_words).toBe(false)

    // Poll calls hit the tasks endpoint with auth.
    expect(calls[1].url).toBe('https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-1')
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer ds-key')

    // Result file fetched unauthenticated, sentences sorted + mapped as ms.
    expect(calls[3].url).toBe('https://results.example.com/t.json')
    expect(res.utterances).toEqual([
      { startMs: 0, endMs: 3500, speaker: null, text: '今日開會' },
      { startMs: 4000, endMs: 9000, speaker: null, text: '之後我哋 launch 個 product' },
      { startMs: 3_500_000, endMs: HOUR_MS - 20_000, speaker: null, text: 'wrap up' },
    ])
    expect(res.truncated).toBe(false)
    expect(res.windows).toBe(1)
    expect(res.usages).toEqual([
      {
        usage: null,
        model: 'dashscope:qwen3-asr-flash-filetrans',
        costUsd: QWEN_FILETRANS_USD_PER_AUDIO_HOUR,
      },
    ])
  })

  it('accepts the results[] (per-file) response shape', async () => {
    const { fetchFn } = scriptedFetch([
      () => mockResponse({ output: { task_id: 't2' } }),
      () =>
        mockResponse({
          output: {
            task_status: 'SUCCEEDED',
            results: [{ transcription_url: 'https://results.example.com/alt.json' }],
          },
        }),
      () =>
        mockResponse({
          transcripts: [{ sentences: [{ begin_time: 0, end_time: HOUR_MS - 1000, text: 'ok' }] }],
        }),
    ])

    const t = qwenFiletransTranscriber({ apiKey: 'k', pollIntervalMs: 0, fetchFn })
    const res = await t.transcribe(REQ)
    expect(res.utterances[0].text).toBe('ok')
  })

  it('throws before any network call when sourceUrl is missing (ladder falls through)', async () => {
    const { fetchFn } = scriptedFetch([() => mockResponse({})])
    const t = qwenFiletransTranscriber({ apiKey: 'k', pollIntervalMs: 0, fetchFn })

    await expect(
      t.transcribe({ buffer: Buffer.from('x'), mime: 'audio/aac', durationMs: 1000 }),
    ).rejects.toThrow(/sourceUrl/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects localhost source URLs before creating a doomed remote task', async () => {
    const { fetchFn } = scriptedFetch([() => mockResponse({})])
    const t = qwenFiletransTranscriber({ apiKey: 'k', pollIntervalMs: 0, fetchFn })

    await expect(t.transcribe({
      ...REQ,
      sourceUrl: 'http://localhost:4000/api/local-files?action=read',
    })).rejects.toThrow(/cannot download a localhost\/private storage URL/i)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('throws on a FAILED task, carrying the task message', async () => {
    const { fetchFn } = scriptedFetch([
      () => mockResponse({ output: { task_id: 't3' } }),
      () => mockResponse({ output: { task_status: 'FAILED', message: 'bad audio format' } }),
    ])
    const t = qwenFiletransTranscriber({ apiKey: 'k', pollIntervalMs: 0, fetchFn })

    await expect(t.transcribe(REQ)).rejects.toThrow(/FAILED.*bad audio format/s)
  })

  it('gives up after maxPolls when the task never settles', async () => {
    const { fetchFn, calls } = scriptedFetch([
      () => mockResponse({ output: { task_id: 't4' } }),
      () => mockResponse({ output: { task_status: 'PENDING' } }),
    ])
    const t = qwenFiletransTranscriber({ apiKey: 'k', pollIntervalMs: 0, maxPolls: 3, fetchFn })

    await expect(t.transcribe(REQ)).rejects.toThrow(/did not settle within 3 polls/)
    expect(calls).toHaveLength(4) // 1 submit + 3 polls
  })

  it('marks truncated when sentences stop far short of the audio end', async () => {
    const { fetchFn } = scriptedFetch([
      () => mockResponse({ output: { task_id: 't5' } }),
      () =>
        mockResponse({
          output: {
            task_status: 'SUCCEEDED',
            result: { transcription_url: 'https://results.example.com/short.json' },
          },
        }),
      () =>
        mockResponse({
          transcripts: [{ sentences: [{ begin_time: 0, end_time: 60_000, text: 'partial' }] }],
        }),
    ])
    const t = qwenFiletransTranscriber({ apiKey: 'k', pollIntervalMs: 0, fetchFn })

    const res = await t.transcribe(REQ)
    expect(res.truncated).toBe(true)
  })
})
