/**
 * X (Twitter) distribution tools.
 *
 * Mirrors `threads/tools.ts` in shape — publishing tools the distribution
 * assistant calls from tuning chat or scheduled jobs to act on its connected
 * X account. The `api` callback object is injected by the API layer so core
 * stays free of OAuth/token-store coupling.
 *
 * Phase 1 (live): twitterCreatePost, twitterDelete, twitterGetInsights,
 *                 twitterListReplies, twitterListMentions.
 * Phase 2 adds:   twitterHideReply, twitterReplyToPost (approval-gated).
 *
 * Platform identity is surfaced through the tool *descriptions* only, per
 * the Tool-awareness rule in root CLAUDE.md.
 *
 * See docs/architecture/feed/twitter.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../../tools/types.js'
import type { VoiceSample, InspirationCandidate } from '../types.js'

// ── API callback surface — what the API layer must provide ──────

export type TwitterApi = {
  /** Posts a text tweet (optionally with up to 4 media ids). Returns the tweet id. */
  createPost(input: {
    text: string
    mediaIds?: string[]
  }): Promise<{ tweetId: string; permalink?: string }>

  /** Deletes a tweet the authenticated user owns. */
  deletePost(input: { tweetId: string }): Promise<void>

  /**
   * Returns per-tweet metrics if tweetId given, else profile-level metrics
   * aggregated over the account's recent timeline.
   */
  getInsights(input: {
    tweetId?: string
    max?: number
  }): Promise<unknown>

  /** Pre-check: is the account within its daily post budget? */
  checkRateBudget(): Promise<{ allowed: boolean; used: number; limit: number }>

  /** List replies to one of the team's tweets (by conversation_id search). */
  listReplies(input: { tweetId: string; limit?: number }): Promise<unknown>

  /** List recent tweets that @-mention the team's account. */
  listMentions(input: { limit?: number }): Promise<unknown>

  /** Hide / unhide a reply on one of the team's tweets. (Phase 2) */
  hideReply(input: { replyId: string; hide: boolean }): Promise<void>

  /**
   * Post a reply. Two callers, mirroring the Threads flow:
   * - Defense pipeline / UI approvals queue: pass a signed `approvalToken`
   *   bound to (assistantId, replyToId, text); the adapter verifies it.
   * - Chat-injected `twitterReplyToPost` tool: omit `approvalToken`. The
   *   tool's `requiresConfirmation: true` already forced the admin to
   *   approve the exact (replyToId, text) on a chat confirmation card
   *   before this method runs, so the adapter mints a `source: 'chat'`
   *   token internally and proceeds.
   */
  replyToPost(input: {
    replyToId: string
    text: string
    approvalToken?: string
  }): Promise<{ replyId: string }>

  // ── Phase 1B — voice + inspiration reads ──────────────────────

  /**
   * Fetch the connected handle's recent originals for voice analysis.
   * The adapter does the platform fetch + filters out retweets, quote-only,
   * pure-media, and replies, then returns the cleaned `VoiceSample[]`.
   * The skill consumes this list to extract voice rules.
   */
  importVoiceSample(input: { limit?: number }): Promise<VoiceSample[]>

  /**
   * Fetch the connected handle's home timeline for inspiration scanning.
   * Returns one batch of candidates, deduplication and scoring happen in
   * the skill.
   */
  listHomeTimelineSource(input: { limit?: number }): Promise<InspirationCandidate[]>

  /** Fetch tweets from an X List the connected handle can see. */
  listFromListSource(input: { listId: string; limit?: number }): Promise<InspirationCandidate[]>

  /** Recent-search by query string. */
  searchTopicSource(input: { query: string; limit?: number }): Promise<InspirationCandidate[]>
}

// ── Tool factory ────────────────────────────────────────────────

export function createTwitterDistributionTools(api: TwitterApi): Tool[] {
  const twitterCreatePost = buildTool({
    name: 'twitterCreatePost',
    description:
      "Publish a tweet on the team's connected X account. Text only in Phase 1 " +
      '(media attachments ship in a follow-up). Tweets count against a per-account ' +
      'daily budget — the tool pre-checks the budget and refuses without side effect ' +
      'when the cap is hit. Max 280 characters. Returns the tweet ID and permalink.',
    inputSchema: z.object({
      text: z
        .string()
        .min(1)
        .max(280)
        .describe('Tweet text (max 280 chars, X limit).'),
    }),
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async execute(input) {
      try {
        const budget = await api.checkRateBudget()
        if (!budget.allowed) {
          return {
            data: `X daily post budget reached (${budget.used}/${budget.limit} in last 24h). Tweet not published.`,
            isError: true,
          }
        }
        const result = await api.createPost({ text: input.text })
        return {
          data: {
            tweetId: result.tweetId,
            permalink: result.permalink ?? null,
            remainingDailyBudget: budget.limit - budget.used - 1,
          },
        }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterDelete = buildTool({
    name: 'twitterDelete',
    description:
      "Delete a tweet from the team's X account. Takes the tweet ID returned by " +
      'twitterCreatePost or visible in recent posts. Permanent — no undo.',
    inputSchema: z.object({
      tweetId: z.string().describe('The X tweet ID to delete.'),
    }),
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        await api.deletePost({ tweetId: input.tweetId })
        return { data: { deleted: input.tweetId } }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterGetInsights = buildTool({
    name: 'twitterGetInsights',
    description:
      'Fetch engagement insights from X. With `tweetId`, returns per-tweet metrics ' +
      '(impressions, likes, replies, retweets, quotes, bookmarks). Without `tweetId`, ' +
      'returns aggregated metrics over the account\'s most recent tweets (profile-level view).',
    inputSchema: z.object({
      tweetId: z
        .string()
        .optional()
        .describe('Tweet ID for per-tweet insights. Omit for recent-timeline aggregate.'),
      max: z
        .number()
        .int()
        .min(5)
        .max(100)
        .optional()
        .describe('For profile-level: number of recent tweets to aggregate (default 20).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.getInsights({ tweetId: input.tweetId, max: input.max })
        return { data }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterListReplies = buildTool({
    name: 'twitterListReplies',
    description:
      "List replies to one of the team's tweets. Uses conversation_id search to " +
      'enumerate responses. Returns id, text, author_id, and created_at per reply. ' +
      'Use when asked "what are people saying about tweet X" or for reply review.',
    inputSchema: z.object({
      tweetId: z.string().describe('The X tweet ID whose replies to read.'),
      limit: z
        .number()
        .int()
        .min(10)
        .max(100)
        .optional()
        .describe('Max replies to return (default 25).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.listReplies({ tweetId: input.tweetId, limit: input.limit })
        return { data }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterListMentions = buildTool({
    name: 'twitterListMentions',
    description:
      "List recent tweets that @-mention the team's X account. Separate from replies " +
      '— mentions are standalone tweets that tagged the account, not comments on the ' +
      'team\'s own tweets. Use for "who\'s tagging us?" or a mention digest.',
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(5)
        .max(100)
        .optional()
        .describe('Max mentions to return (default 25).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.listMentions({ limit: input.limit })
        return { data }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterHideReply = buildTool({
    name: 'twitterHideReply',
    description:
      "Hide or unhide a reply on one of the team's tweets. Hidden replies are still " +
      'visible to the original commenter but moved out of the main thread view. ' +
      'Use for spam or clearly off-topic replies. Pass hide=true to hide, hide=false ' +
      'to unhide. Takes the replyId from twitterListReplies.',
    inputSchema: z.object({
      replyId: z.string().describe('The reply tweet ID to hide or unhide.'),
      hide: z.boolean().describe('true to hide, false to unhide.'),
    }),
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        await api.hideReply({ replyId: input.replyId, hide: input.hide })
        return { data: { replyId: input.replyId, hidden: input.hide } }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterReplyToPost = buildTool({
    name: 'twitterReplyToPost',
    description:
      'Post a reply to an existing tweet on X. The exact (replyToId, text) ' +
      'is shown on a confirmation card and an admin must click Approve ' +
      'before the reply is sent — that click is the human gate; the model ' +
      'cannot post anything without it. Use this when the team asks you to ' +
      'reply directly from chat. (Inbound mentions arriving via the webhook ' +
      'still flow through the defense pipeline + drafts queue; do not call ' +
      'this tool to handle those — the queue handles them.)',
    inputSchema: z.object({
      replyToId: z.string().describe('Target tweet id to respond to.'),
      text: z.string().min(1).max(280).describe('Reply body (X caps at 280 chars).'),
    }),
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async execute(input) {
      try {
        const result = await api.replyToPost({
          replyToId: input.replyToId,
          text: input.text,
        })
        return { data: { replyId: result.replyId } }
      } catch (err) {
        return {
          data: `X reply error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  // ── Phase 1B — voice + inspiration tools ──────────────────────

  const twitterImportVoiceSample = buildTool({
    name: 'twitterImportVoiceSample',
    description:
      "Fetch the team's recent originals (RTs, replies, quote-only, and pure-media " +
      'posts already filtered out) for voice analysis. Use only inside the ' +
      '`import-voice-from-x` skill — analyzing this output and proposing voice rules ' +
      'is the skill\'s job, not a one-shot tool call. Returns up to 200 originals; ' +
      'high-volume accounts may see only their most recent few days. If fewer than 20 ' +
      'originals come back, decline to extract rules and surface that to the operator.',
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(20)
        .max(200)
        .optional()
        .describe('Cap on raw fetch size (default 200). After RT/reply/media filtering, ~50–150 typically remain.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 30_000,

    async execute(input) {
      try {
        const samples = await api.importVoiceSample({ limit: input.limit })
        return {
          data: {
            count: samples.length,
            samples,
          },
        }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterListHomeTimeline = buildTool({
    name: 'twitterListHomeTimeline',
    description:
      "Read the connected handle's home timeline (reverse chronological) as candidate " +
      'posts to reply to. Use only inside the `scan-inspiration` skill — the skill ' +
      'dedups across sources, filters already-replied-to posts, and scores against the ' +
      'team voice. Returns up to 100 candidates per call.',
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(10)
        .max(100)
        .optional()
        .describe('Max candidates (default 50).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const candidates = await api.listHomeTimelineSource({ limit: input.limit })
        return { data: { count: candidates.length, candidates } }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterListFromList = buildTool({
    name: 'twitterListFromList',
    description:
      "Read recent tweets from an X List the connected handle owns or follows. Lists " +
      "are operator-curated and tend to be the highest-signal inspiration source. The " +
      "list ID typically comes from the `inspiration:list_id` team memory; ask the " +
      'operator if it\'s not configured.',
    inputSchema: z.object({
      listId: z.string().describe('The X List ID (numeric string from the List URL).'),
      limit: z
        .number()
        .int()
        .min(10)
        .max(100)
        .optional()
        .describe('Max candidates (default 50).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const candidates = await api.listFromListSource({
          listId: input.listId,
          limit: input.limit,
        })
        return { data: { count: candidates.length, candidates } }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const twitterSearchTopic = buildTool({
    name: 'twitterSearchTopic',
    description:
      "Recent-search across X for a topic query. Used by the `scan-inspiration` skill " +
      'when the operator has configured an `inspiration:search_query`. Supports X search ' +
      'operators (e.g. `lang:en`, `-is:retweet`, `has:links`). Returns up to 100 candidates.',
    inputSchema: z.object({
      query: z.string().describe('Search query string (X recent-search syntax).'),
      limit: z
        .number()
        .int()
        .min(10)
        .max(100)
        .optional()
        .describe('Max candidates (default 50).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const candidates = await api.searchTopicSource({
          query: input.query,
          limit: input.limit,
        })
        return { data: { count: candidates.length, candidates } }
      } catch (err) {
        return {
          data: `X error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  return [
    twitterCreatePost,
    twitterDelete,
    twitterGetInsights,
    twitterListReplies,
    twitterListMentions,
    twitterHideReply,
    twitterReplyToPost,
    twitterImportVoiceSample,
    twitterListHomeTimeline,
    twitterListFromList,
    twitterSearchTopic,
  ]
}
