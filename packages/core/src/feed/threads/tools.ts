/**
 * Threads tools — Phase 1 subset.
 *
 * Publishing tools the distribution assistant calls from the tuning chat
 * (or from a scheduled-job session) to act on its connected Threads account.
 *
 * Phase 1: threadsCreatePost, threadsDelete, threadsGetInsights.
 * Phase 2 adds: threadsReplyToPost (approval-gated), threadsListReplies,
 *               threadsListMentions, threadsHideReply.
 *
 * The `api` callback object is injected by the API layer so core stays
 * free of OAuth/token-store coupling.
 *
 * See docs/architecture/feed/threads.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../../tools/types.js'
import { TEXT_SPOILER_MAX, ThreadsTextSpoiler } from './types.js'

// ── API callback surface — what the API layer must provide ──────

export type ThreadsApi = {
  /** Posts a text / image / carousel post. Returns the published post id. */
  createPost(input: {
    text?: string
    imageUrl?: string
    carouselImageUrls?: string[]
    /** When true, blur every attached image/video until the reader taps. Ignored on text-only posts. */
    isSpoilerMedia?: boolean
    /** Character ranges in `text` to blur as spoilers. Up to 10 ranges. */
    textSpoilers?: Array<{ offset: number; length: number }>
    /**
     * Single Threads topic tag. Threads limits to one tag per post; the
     * Graph API rejects `.` and `&` characters and tags ≥51 chars.
     * Surfaced today only by the draft-app's post-intent hero composer
     * (Threads only); the chat-injected tool path leaves it unset.
     */
    topicTag?: string
  }): Promise<{ postId: string; permalink?: string }>

  /** Deletes a post the assistant's account owns. */
  deletePost(input: { mediaId: string }): Promise<void>

  /** Returns per-post metrics if mediaId given, else profile-level 7-day. */
  getInsights(input: {
    mediaId?: string
    since?: string
    until?: string
  }): Promise<unknown>

  /** Pre-check: is the account within its 250 posts / 24h budget? */
  checkRateBudget(): Promise<{ allowed: boolean; used: number; limit: number }>

  /** List replies on one of the team's posts. */
  listReplies(input: { mediaId: string; limit?: number }): Promise<unknown>

  /** List recent posts that @-mention the team's account. */
  listMentions(input: { limit?: number }): Promise<unknown>

  /** Hide or unhide a reply on one of the team's posts. */
  hideReply(input: { replyId: string; hide: boolean }): Promise<void>

  /**
   * Post a reply. Two callers:
   * - Defense pipeline / UI approvals queue: pass a signed `approvalToken`
   *   bound to (assistantId, replyToId, text). The adapter verifies it.
   * - Chat-injected `threadsReplyToPost` tool: omit `approvalToken`. The
   *   tool's `requiresConfirmation: true` already forced the admin to
   *   approve the exact (replyToId, text) on a chat confirmation card
   *   before this method runs, so the adapter mints a `source: 'chat'`
   *   token internally and proceeds.
   *
   * Never reachable from prompt-compromised assistant state without one
   * of those two human (or pipeline) gates upstream.
   */
  replyToPost(input: {
    replyToId: string
    text: string
    approvalToken?: string
  }): Promise<{
    replyId: string
    /**
     * Set when Meta returned a 5xx from `/threads_publish` but a follow-up
     * container-status check confirmed the reply was published anyway. Lets
     * the caller log the recovery without changing the success response.
     */
    recovered?: boolean
  }>
}

// ── Tool factory ────────────────────────────────────────────────

export function createDistributionTools(api: ThreadsApi): Tool[] {
  const threadsCreatePost = buildTool({
    name: 'threadsCreatePost',
    description:
      'Publish a post on the team\'s connected Threads account. ' +
      'For a text-only post, pass `text`. For an image post, pass `imageUrl` ' +
      '(must be a publicly fetchable URL that Meta can download). For a ' +
      'carousel, pass `carouselImageUrls` (2-20 URLs) and optional `text` caption. ' +
      'Posts count against a 250-per-24-hour cap — the tool pre-checks the budget ' +
      'and refuses without side effect when the cap is hit. Returns the post ID ' +
      'and public permalink. ' +
      'Spoilers (tap-to-reveal): set `isSpoilerMedia: true` to blur every attached ' +
      'image/video (image or carousel posts only). Pass `textSpoilers` as an array ' +
      'of `{offset, length}` character ranges to blur substrings of `text` — useful ' +
      'when the body teases a reveal or contains a sensitive detail. Up to 10 text ' +
      'ranges per post; offsets are 0-based character positions into `text`. ' +
      'Use spoilers when the team asks ("hide the punchline", "blur the photos", ' +
      '"mark as spoiler") or when the content reveals an outcome readers may want ' +
      'to opt into seeing.',
    inputSchema: z.object({
      text: z
        .string()
        .max(500)
        .optional()
        .describe('Post text (max 500 chars, Threads limit).'),
      imageUrl: z
        .string()
        .url()
        .optional()
        .describe('Publicly-fetchable image URL for a single-image post.'),
      carouselImageUrls: z
        .array(z.string().url())
        .min(2)
        .max(20)
        .optional()
        .describe('2-20 publicly-fetchable image URLs for a carousel post.'),
      isSpoilerMedia: z
        .boolean()
        .optional()
        .describe(
          'Blur every attached image/video until the reader taps. Only valid on image or carousel posts; ignored on text-only posts.',
        ),
      textSpoilers: z
        .array(ThreadsTextSpoiler)
        .max(TEXT_SPOILER_MAX)
        .optional()
        .describe(
          'Character ranges in `text` to blur as spoilers. Each entry is `{offset, length}` (0-based character indices). Up to 10 ranges per post.',
        ),
    }),
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async execute(input) {
      if (!input.text && !input.imageUrl && !input.carouselImageUrls) {
        return {
          data: 'threadsCreatePost requires at least one of: text, imageUrl, carouselImageUrls.',
          isError: true,
        }
      }
      if (input.imageUrl && input.carouselImageUrls) {
        return {
          data: 'threadsCreatePost: choose either imageUrl (single) or carouselImageUrls (multi), not both.',
          isError: true,
        }
      }
      if (input.isSpoilerMedia && !input.imageUrl && !input.carouselImageUrls) {
        return {
          data: 'threadsCreatePost: isSpoilerMedia requires an image or carousel post.',
          isError: true,
        }
      }
      if (input.textSpoilers && input.textSpoilers.length > 0) {
        if (!input.text) {
          return {
            data: 'threadsCreatePost: textSpoilers requires `text` to be present.',
            isError: true,
          }
        }
        const overrun = input.textSpoilers.find(
          (e) => e.offset + e.length > (input.text ?? '').length,
        )
        if (overrun) {
          return {
            data: `threadsCreatePost: textSpoilers range {offset:${overrun.offset}, length:${overrun.length}} extends past end of text (${input.text.length} chars).`,
            isError: true,
          }
        }
      }
      try {
        const budget = await api.checkRateBudget()
        if (!budget.allowed) {
          return {
            data: `Threads daily post budget reached (${budget.used}/${budget.limit} in last 24h). Post not published.`,
            isError: true,
          }
        }
        const result = await api.createPost({
          text: input.text,
          imageUrl: input.imageUrl,
          carouselImageUrls: input.carouselImageUrls,
          isSpoilerMedia: input.isSpoilerMedia,
          textSpoilers: input.textSpoilers,
        })
        return {
          data: {
            postId: result.postId,
            permalink: result.permalink ?? null,
            remainingDailyBudget: budget.limit - budget.used - 1,
          },
        }
      } catch (err) {
        return {
          data: `Threads error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const threadsDelete = buildTool({
    name: 'threadsDelete',
    description:
      'Delete a post from the team\'s Threads account. Takes the post ID returned ' +
      'by threadsCreatePost or visible in recent posts. Permanent — no undo.',
    inputSchema: z.object({
      mediaId: z.string().describe('The Threads post (media) ID to delete.'),
    }),
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        await api.deletePost({ mediaId: input.mediaId })
        return { data: { deleted: input.mediaId } }
      } catch (err) {
        return {
          data: `Threads error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const threadsGetInsights = buildTool({
    name: 'threadsGetInsights',
    description:
      'Fetch engagement insights from Threads. With `mediaId`, returns per-post ' +
      'metrics (views, likes, replies, reposts, quotes). Without `mediaId`, returns ' +
      'profile-level metrics for the given date range (defaults to last 7 days), ' +
      'including followers_count trend.',
    inputSchema: z.object({
      mediaId: z
        .string()
        .optional()
        .describe('Post ID for per-post insights. Omit for profile-level insights.'),
      since: z
        .string()
        .optional()
        .describe('ISO date for profile-level range start. Defaults to 7 days ago.'),
      until: z
        .string()
        .optional()
        .describe('ISO date for profile-level range end. Defaults to now.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.getInsights({
          mediaId: input.mediaId,
          since: input.since,
          until: input.until,
        })
        return { data }
      } catch (err) {
        return {
          data: `Threads error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const threadsListReplies = buildTool({
    name: 'threadsListReplies',
    description:
      'List replies on one of the team\'s Threads posts. Returns id, text, commenter username, ' +
      'timestamp, and hide status for each reply. Use this to check what people are saying about ' +
      'a specific post. Pass the mediaId returned by threadsCreatePost or visible in recent posts.',
    inputSchema: z.object({
      mediaId: z.string().describe('The Threads post ID whose replies to read.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max replies to return (default 25).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.listReplies({ mediaId: input.mediaId, limit: input.limit })
        return { data }
      } catch (err) {
        return {
          data: `Threads error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const threadsListMentions = buildTool({
    name: 'threadsListMentions',
    description:
      'List recent posts by other users that @-mention the team\'s Threads account. ' +
      'Separate from replies — mentions are standalone posts that tagged the account, not ' +
      'comments on the team\'s own posts. Use this when asked "who\'s tagging us?" or for ' +
      'a mention digest.',
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
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
          data: `Threads error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const threadsHideReply = buildTool({
    name: 'threadsHideReply',
    description:
      'Hide or unhide a reply on one of the team\'s posts. Hiding removes the reply from the ' +
      'public thread view (but the reply still exists for the original commenter). Use for ' +
      'spam or clearly off-topic replies. Pass hide=true to hide, hide=false to unhide. ' +
      'Takes the replyId from threadsListReplies.',
    inputSchema: z.object({
      replyId: z.string().describe('The reply ID to hide or unhide.'),
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
          data: `Threads error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  const threadsReplyToPost = buildTool({
    name: 'threadsReplyToPost',
    description:
      'Post a reply to an existing post or reply on Threads. The exact ' +
      '(replyToId, text) is shown on a confirmation card and an admin must ' +
      'click Approve before the reply is sent — that click is the human ' +
      'gate; the model cannot post anything without it. Use this when the ' +
      'team asks you to reply directly from chat. (Inbound replies arriving ' +
      'via the webhook still flow through the defense pipeline + drafts ' +
      'queue; do not call this tool to handle those — the queue handles them.)',
    inputSchema: z.object({
      replyToId: z.string().describe('Target reply or post id to respond to.'),
      text: z.string().min(1).max(500).describe('Reply body (Threads caps at 500 chars).'),
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
          data: `Threads reply error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  return [
    threadsCreatePost,
    threadsDelete,
    threadsGetInsights,
    threadsListReplies,
    threadsListMentions,
    threadsHideReply,
    threadsReplyToPost,
  ]
}
