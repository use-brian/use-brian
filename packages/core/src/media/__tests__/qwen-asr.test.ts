import { describe, expect, it, vi } from 'vitest'
import { qwenAsrTranscriber, QWEN_ASR_USD_PER_AUDIO_HOUR } from '../qwen-asr.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('[COMP:media/transcriber-qwen] qwenAsrTranscriber', () => {
  it('submits local bytes as a base64 audio data URL', async () => {
    const fetchFn = vi.fn(async () => response({
      choices: [{ message: { content: 'halo halo halo' } }],
    })) as unknown as typeof fetch
    const transcriber = qwenAsrTranscriber({ apiKey: 'ds-key', fetchFn })

    const result = await transcriber.transcribe({
      buffer: Buffer.from('audio-bytes'),
      mime: 'audio/mp4',
      durationMs: 2000,
      language: 'en',
    })

    expect(transcriber.name).toBe('dashscope:qwen3-asr-flash')
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer ds-key')
    const body = JSON.parse(init.body)
    expect(body.messages[0].content[0].input_audio.data).toBe(
      `data:audio/mp4;base64,${Buffer.from('audio-bytes').toString('base64')}`,
    )
    expect(body.asr_options).toEqual({ enable_itn: false, language: 'en' })
    expect(result.utterances).toEqual([
      { startMs: 0, endMs: 2000, speaker: null, text: 'halo halo halo' },
    ])
    expect(result.usages[0].costUsd).toBeCloseTo((2 / 3600) * QWEN_ASR_USD_PER_AUDIO_HOUR)
  })

  it('normalizes a compatible-mode base URL and honors the model override', async () => {
    const fetchFn = vi.fn(async () => response({
      choices: [{ message: { content: 'transcript' } }],
    })) as unknown as typeof fetch
    const transcriber = qwenAsrTranscriber({
      apiKey: 'key',
      baseUrl: 'https://dashscope.example/compatible-mode/v1/',
      model: 'regional-asr',
      fetchFn,
    })

    await transcriber.transcribe({
      buffer: Buffer.from('audio'),
      mime: 'audio/mp4',
      durationMs: 1000,
    })

    expect(transcriber.name).toBe('dashscope:regional-asr')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://dashscope.example/compatible-mode/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"model":"regional-asr"'),
      }),
    )
  })

  it('fails before the network when the audio exceeds five minutes', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    const transcriber = qwenAsrTranscriber({ apiKey: 'key', fetchFn })

    await expect(transcriber.transcribe({
      buffer: Buffer.from('x'),
      mime: 'audio/mp4',
      durationMs: 5 * 60_000 + 1,
    })).rejects.toThrow(/up to 5 minutes/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('surfaces provider errors and empty transcripts', async () => {
    const bad = qwenAsrTranscriber({
      apiKey: 'key',
      fetchFn: vi.fn(async () => response({ error: 'bad audio' }, 400)) as unknown as typeof fetch,
    })
    await expect(bad.transcribe({
      buffer: Buffer.from('x'), mime: 'audio/mp4', durationMs: 1000,
    })).rejects.toThrow(/HTTP 400/)

    const empty = qwenAsrTranscriber({
      apiKey: 'key',
      fetchFn: vi.fn(async () => response({ choices: [{ message: { content: '  ' } }] })) as unknown as typeof fetch,
    })
    await expect(empty.transcribe({
      buffer: Buffer.from('x'), mime: 'audio/mp4', durationMs: 1000,
    })).rejects.toThrow(/empty transcript/)
  })
})
