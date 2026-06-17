/**
 * Unit tests for the Threads distribution tools.
 * Component tag: [COMP:distribution/threads-tools].
 *
 * Verifies createDistributionTools: the seven-tool surface + flags, and
 * threadsCreatePost's pre-flight validation ladder (one-of text/image/
 * carousel, image-xor-carousel, spoiler-media needs media, text-spoiler
 * needs text, spoiler range overrun), the rate-budget refusal with no
 * side effect, the success payload's remainingDailyBudget, and the
 * `Threads error:` mapping shared across the tools.
 */

import { describe, it, expect, vi } from 'vitest'
import { createDistributionTools, type ThreadsApi } from '../tools.js'
import type { Tool, ToolContext } from '../../../tools/types.js'

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c-1',
  abortSignal: new AbortController().signal,
}

function stubApi(over: Partial<ThreadsApi> = {}): ThreadsApi {
  return {
    createPost: vi.fn().mockResolvedValue({ postId: 'p-1', permalink: 'http://t/p-1' }),
    deletePost: vi.fn().mockResolvedValue(undefined),
    getInsights: vi.fn().mockResolvedValue({ views: 10 }),
    checkRateBudget: vi.fn().mockResolvedValue({ allowed: true, used: 5, limit: 250 }),
    listReplies: vi.fn().mockResolvedValue([]),
    listMentions: vi.fn().mockResolvedValue([]),
    hideReply: vi.fn().mockResolvedValue(undefined),
    replyToPost: vi.fn().mockResolvedValue({ replyId: 'r-1' }),
    ...over,
  }
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('[COMP:distribution/threads-tools] createDistributionTools', () => {
  it('exposes the seven Threads tools with the expected flags', () => {
    const tools = createDistributionTools(stubApi())
    expect(tools.map((t) => t.name)).toEqual([
      'threadsCreatePost',
      'threadsDelete',
      'threadsGetInsights',
      'threadsListReplies',
      'threadsListMentions',
      'threadsHideReply',
      'threadsReplyToPost',
    ])
    expect(byName(tools, 'threadsCreatePost').requiresConfirmation).toBe(true)
    for (const r of ['threadsGetInsights', 'threadsListReplies', 'threadsListMentions']) {
      const tool = byName(tools, r)
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
    }
  })

  it('threadsCreatePost rejects an empty post with no api call', async () => {
    const api = stubApi()
    const post = byName(createDistributionTools(api), 'threadsCreatePost')
    const res = await post.execute({}, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toContain('at least one of')
    expect(api.checkRateBudget).not.toHaveBeenCalled()
    expect(api.createPost).not.toHaveBeenCalled()
  })

  it('threadsCreatePost rejects imageUrl together with carouselImageUrls', async () => {
    const post = byName(createDistributionTools(stubApi()), 'threadsCreatePost')
    const res = await post.execute(
      { imageUrl: 'http://i/1.png', carouselImageUrls: ['http://i/2.png', 'http://i/3.png'] },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(res.data).toContain('not both')
  })

  it('threadsCreatePost rejects isSpoilerMedia on a text-only post', async () => {
    const post = byName(createDistributionTools(stubApi()), 'threadsCreatePost')
    const res = await post.execute({ text: 'hi', isSpoilerMedia: true }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toContain('requires an image or carousel')
  })

  it('threadsCreatePost rejects a textSpoiler range that overruns the text', async () => {
    const post = byName(createDistributionTools(stubApi()), 'threadsCreatePost')
    const res = await post.execute(
      { text: 'hi', textSpoilers: [{ offset: 0, length: 5 }] },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(res.data).toContain('extends past end of text')
  })

  it('threadsCreatePost refuses without side effect when the daily budget is spent', async () => {
    const api = stubApi({
      checkRateBudget: vi.fn().mockResolvedValue({ allowed: false, used: 250, limit: 250 }),
    })
    const post = byName(createDistributionTools(api), 'threadsCreatePost')
    const res = await post.execute({ text: 'hello' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toContain('budget reached')
    expect(api.createPost).not.toHaveBeenCalled()
  })

  it('threadsCreatePost returns the post id and remaining budget on success', async () => {
    const api = stubApi({
      checkRateBudget: vi.fn().mockResolvedValue({ allowed: true, used: 9, limit: 250 }),
    })
    const post = byName(createDistributionTools(api), 'threadsCreatePost')
    const res = await post.execute({ text: 'hello' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(res.data).toEqual({ postId: 'p-1', permalink: 'http://t/p-1', remainingDailyBudget: 240 })
  })

  it('threadsCreatePost maps an api throw to a Threads error result', async () => {
    const api = stubApi({ createPost: vi.fn().mockRejectedValue(new Error('graph down')) })
    const post = byName(createDistributionTools(api), 'threadsCreatePost')
    const res = await post.execute({ text: 'hello' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toBe('Threads error: graph down')
  })

  it('threadsDelete and threadsHideReply echo their target ids back', async () => {
    const tools = createDistributionTools(stubApi())
    const del = await byName(tools, 'threadsDelete').execute({ mediaId: 'm-1' }, ctx)
    expect(del.data).toEqual({ deleted: 'm-1' })
    const hide = await byName(tools, 'threadsHideReply').execute(
      { replyId: 'r-9', hide: true },
      ctx,
    )
    expect(hide.data).toEqual({ replyId: 'r-9', hidden: true })
  })

  it('threadsReplyToPost returns the reply id and uses a reply-specific error prefix', async () => {
    const ok = byName(createDistributionTools(stubApi()), 'threadsReplyToPost')
    expect((await ok.execute({ replyToId: 'p-1', text: 'thanks' }, ctx)).data).toEqual({
      replyId: 'r-1',
    })
    const failing = byName(
      createDistributionTools(
        stubApi({ replyToPost: vi.fn().mockRejectedValue(new Error('429')) }),
      ),
      'threadsReplyToPost',
    )
    const res = await failing.execute({ replyToId: 'p-1', text: 'thanks' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toBe('Threads reply error: 429')
  })
})
