/**
 * Unit tests for the X (Twitter) distribution tools.
 * Component tag: [COMP:distribution/twitter-tools].
 *
 * Verifies createTwitterDistributionTools: the eleven-tool surface +
 * read/write flags, twitterCreatePost's rate-budget refusal (no side
 * effect) and remainingDailyBudget success payload, the shared `X error:`
 * mapping, twitterReplyToPost's reply-specific prefix, and the voice /
 * inspiration read tools' `{ count, ... }` envelope.
 */

import { describe, it, expect, vi } from 'vitest'
import { createTwitterDistributionTools, type TwitterApi } from '../tools.js'
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

function stubApi(over: Partial<TwitterApi> = {}): TwitterApi {
  return {
    createPost: vi.fn().mockResolvedValue({ tweetId: 't-1', permalink: 'http://x/t-1' }),
    deletePost: vi.fn().mockResolvedValue(undefined),
    getInsights: vi.fn().mockResolvedValue({ impressions: 99 }),
    checkRateBudget: vi.fn().mockResolvedValue({ allowed: true, used: 3, limit: 100 }),
    listReplies: vi.fn().mockResolvedValue([]),
    listMentions: vi.fn().mockResolvedValue([]),
    hideReply: vi.fn().mockResolvedValue(undefined),
    replyToPost: vi.fn().mockResolvedValue({ replyId: 'r-1' }),
    importVoiceSample: vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]),
    listHomeTimelineSource: vi.fn().mockResolvedValue([{ id: 'c1' }]),
    listFromListSource: vi.fn().mockResolvedValue([{ id: 'c2' }, { id: 'c3' }]),
    searchTopicSource: vi.fn().mockResolvedValue([]),
    ...over,
  }
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('[COMP:distribution/twitter-tools] createTwitterDistributionTools', () => {
  it('exposes the eleven X tools with the expected read/write flags', () => {
    const tools = createTwitterDistributionTools(stubApi())
    expect(tools.map((t) => t.name)).toEqual([
      'twitterCreatePost',
      'twitterDelete',
      'twitterGetInsights',
      'twitterListReplies',
      'twitterListMentions',
      'twitterHideReply',
      'twitterReplyToPost',
      'twitterImportVoiceSample',
      'twitterListHomeTimeline',
      'twitterListFromList',
      'twitterSearchTopic',
    ])
    for (const w of ['twitterCreatePost', 'twitterDelete', 'twitterHideReply', 'twitterReplyToPost']) {
      expect(byName(tools, w).requiresConfirmation).toBe(true)
    }
    for (const r of [
      'twitterGetInsights',
      'twitterListReplies',
      'twitterListMentions',
      'twitterImportVoiceSample',
      'twitterListHomeTimeline',
      'twitterListFromList',
      'twitterSearchTopic',
    ]) {
      const tool = byName(tools, r)
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
    }
  })

  it('twitterCreatePost refuses without side effect when the budget is spent', async () => {
    const api = stubApi({
      checkRateBudget: vi.fn().mockResolvedValue({ allowed: false, used: 100, limit: 100 }),
    })
    const post = byName(createTwitterDistributionTools(api), 'twitterCreatePost')
    const res = await post.execute({ text: 'hello' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toContain('budget reached')
    expect(api.createPost).not.toHaveBeenCalled()
  })

  it('twitterCreatePost returns the tweet id and remaining budget on success', async () => {
    const api = stubApi({
      checkRateBudget: vi.fn().mockResolvedValue({ allowed: true, used: 10, limit: 100 }),
    })
    const post = byName(createTwitterDistributionTools(api), 'twitterCreatePost')
    const res = await post.execute({ text: 'hello' }, ctx)
    expect(res.data).toEqual({ tweetId: 't-1', permalink: 'http://x/t-1', remainingDailyBudget: 89 })
  })

  it('twitterCreatePost maps an api throw to an `X error:` result', async () => {
    const api = stubApi({ createPost: vi.fn().mockRejectedValue(new Error('suspended')) })
    const post = byName(createTwitterDistributionTools(api), 'twitterCreatePost')
    const res = await post.execute({ text: 'hello' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toBe('X error: suspended')
  })

  it('twitterReplyToPost echoes the reply id and uses a reply-specific error prefix', async () => {
    const ok = byName(createTwitterDistributionTools(stubApi()), 'twitterReplyToPost')
    expect((await ok.execute({ replyToId: 't-1', text: 'thanks' }, ctx)).data).toEqual({
      replyId: 'r-1',
    })
    const failing = byName(
      createTwitterDistributionTools(
        stubApi({ replyToPost: vi.fn().mockRejectedValue(new Error('locked')) }),
      ),
      'twitterReplyToPost',
    )
    const res = await failing.execute({ replyToId: 't-1', text: 'thanks' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toBe('X reply error: locked')
  })

  it('twitterImportVoiceSample wraps the samples in a counted envelope', async () => {
    const api = stubApi()
    const tool = byName(createTwitterDistributionTools(api), 'twitterImportVoiceSample')
    const res = await tool.execute({ limit: 50 }, ctx)
    expect(api.importVoiceSample).toHaveBeenCalledWith({ limit: 50 })
    expect(res.data).toEqual({ count: 2, samples: [{ id: 's1' }, { id: 's2' }] })
  })

  it('the inspiration tools forward their args and return a counted candidate envelope', async () => {
    const api = stubApi()
    const tools = createTwitterDistributionTools(api)
    const fromList = await byName(tools, 'twitterListFromList').execute(
      { listId: 'L-9', limit: 30 },
      ctx,
    )
    expect(api.listFromListSource).toHaveBeenCalledWith({ listId: 'L-9', limit: 30 })
    expect(fromList.data).toEqual({ count: 2, candidates: [{ id: 'c2' }, { id: 'c3' }] })

    const search = await byName(tools, 'twitterSearchTopic').execute({ query: 'lang:en ai' }, ctx)
    expect(api.searchTopicSource).toHaveBeenCalledWith({ query: 'lang:en ai', limit: undefined })
    expect(search.data).toEqual({ count: 0, candidates: [] })

    const home = await byName(tools, 'twitterListHomeTimeline').execute({}, ctx)
    expect(home.data).toEqual({ count: 1, candidates: [{ id: 'c1' }] })
  })
})
