/**
 * Zod schemas for Meta Threads Graph API responses.
 *
 * Only the fields we consume are modeled; extra fields are tolerated.
 * See docs/architecture/feed/threads.md.
 */

import { z } from 'zod'

// ── OAuth responses ─────────────────────────────────────────────

export const ShortLivedTokenResponse = z.object({
  access_token: z.string(),
  user_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
})
export type ShortLivedTokenResponse = z.infer<typeof ShortLivedTokenResponse>

export const LongLivedTokenResponse = z.object({
  access_token: z.string(),
  token_type: z.string().optional(),
  expires_in: z.number(), // seconds
})
export type LongLivedTokenResponse = z.infer<typeof LongLivedTokenResponse>

// ── Profile ─────────────────────────────────────────────────────

export const ThreadsProfile = z.object({
  id: z.string(),
  username: z.string(),
  threads_profile_picture_url: z.string().optional(),
  threads_biography: z.string().optional(),
})
export type ThreadsProfile = z.infer<typeof ThreadsProfile>

// ── Media (post) ────────────────────────────────────────────────

// Meta's Threads Graph API documents `CAROUSEL` on the create path but
// returns `CAROUSEL_ALBUM` on `GET /{media-id}` for some legacy/multi-image
// posts (same as Instagram Graph). Preprocess so the inbound `CAROUSEL_ALBUM`
// flattens to `CAROUSEL` before enum validation, keeping every downstream
// comparison (`post.mediaType === 'CAROUSEL'`) working unchanged.
export const ThreadsMediaType = z.preprocess(
  (v) => (v === 'CAROUSEL_ALBUM' ? 'CAROUSEL' : v),
  z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL', 'AUDIO']),
)
export type ThreadsMediaType = z.infer<typeof ThreadsMediaType>

// ── Spoiler entities ────────────────────────────────────────────
//
// Threads supports two spoiler controls (per
// https://developers.facebook.com/docs/threads/create-posts/spoilers):
//   - `text_entities`: array of `{entity_type:'SPOILER', offset, length}`
//     ranges that get blurred until the reader taps. Max 10 per post.
//   - `is_spoiler_media`: boolean that blurs every attached media item.
//     Only valid on IMAGE / VIDEO / CAROUSEL posts.

export const TEXT_SPOILER_MAX = 10

/** A single text-spoiler range. `entity_type` is implied and added by the client. */
export const ThreadsTextSpoiler = z.object({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
})
export type ThreadsTextSpoiler = z.infer<typeof ThreadsTextSpoiler>

export const ThreadsMediaContainer = z.object({
  id: z.string(),
})
export type ThreadsMediaContainer = z.infer<typeof ThreadsMediaContainer>

export const ThreadsPublishedMedia = z.object({
  id: z.string(),
})
export type ThreadsPublishedMedia = z.infer<typeof ThreadsPublishedMedia>

// ── Container status (for verify-after-publish) ────────────────
//
// `GET /v1.0/{container-id}?fields=status,error_message` is the
// documented way to ask Meta whether a container we created has been
// published. The status set is identical to Instagram Graph's:
//   - IN_PROGRESS — Meta is still processing
//   - FINISHED    — ready to publish (publish call not yet made / not yet
//                   acknowledged by Meta)
//   - PUBLISHED   — published to Threads (terminal-success)
//   - ERROR       — Meta refused to publish; `error_message` populated
//   - EXPIRED     — container older than 24h, never published
//
// Used by the verify-after-publish recovery path in the api adapter
// (`packages/api/src/feed/threads-api.ts`) when `/threads_publish`
// returns 5xx — Meta sometimes acks the publish on their side but
// returns a transient error on the response leg, leading to a duplicate
// reply if we retry without checking.

export const ThreadsContainerStatusValue = z.enum([
  'IN_PROGRESS',
  'FINISHED',
  'PUBLISHED',
  'ERROR',
  'EXPIRED',
])
export type ThreadsContainerStatusValue = z.infer<typeof ThreadsContainerStatusValue>

export const ThreadsContainerStatusResponse = z.object({
  id: z.string(),
  status: ThreadsContainerStatusValue,
  error_message: z.string().optional(),
})
export type ThreadsContainerStatusResponse = z.infer<typeof ThreadsContainerStatusResponse>

export const ThreadsMediaDetails = z.object({
  id: z.string(),
  media_type: ThreadsMediaType.optional(),
  media_url: z.string().optional(),
  permalink: z.string().optional(),
  text: z.string().optional(),
  timestamp: z.string().optional(),
  username: z.string().optional(),
})
export type ThreadsMediaDetails = z.infer<typeof ThreadsMediaDetails>

// ── Insights ────────────────────────────────────────────────────

export const ThreadsInsightMetric = z.object({
  name: z.string(),
  period: z.string().optional(),
  // For time-series metrics (currently `followers_count`), Meta returns
  // one entry per day in the requested range, each carrying the day's
  // `end_time`. The dashboard's per-day trend chart aligns these against
  // the post-bucketed metrics; without `end_time` we'd have to infer
  // dates from array position which breaks if Meta sparsely fills days.
  values: z
    .array(z.object({ value: z.number(), end_time: z.string().optional() }))
    .optional(),
  total_value: z.object({ value: z.number() }).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
})
export const ThreadsInsightsResponse = z.object({
  data: z.array(ThreadsInsightMetric),
})
export type ThreadsInsightsResponse = z.infer<typeof ThreadsInsightsResponse>

// ── Replies (Phase 2 shape, kept here so types are colocated) ──

export const ThreadsReply = z.object({
  id: z.string(),
  text: z.string().optional(),
  username: z.string().optional(),
  timestamp: z.string().optional(),
  root_post: z.object({ id: z.string() }).optional(),
  replied_to: z.object({ id: z.string() }).optional(),
  hide_status: z.enum(['NOT_HUSHED', 'UNHUSHED', 'HIDDEN', 'COVERED', 'BLOCKED']).optional(),
  has_replies: z.boolean().optional(),
})
export type ThreadsReply = z.infer<typeof ThreadsReply>

export const ThreadsRepliesResponse = z.object({
  data: z.array(ThreadsReply),
  paging: z
    .object({
      cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
})
export type ThreadsRepliesResponse = z.infer<typeof ThreadsRepliesResponse>

// ── Profile post listings (used by URL-paste resolver) ──────────
//
// `GET /v1.0/{userId}/threads` and `GET /v1.0/profile_posts?username=…`
// return the same row shape: `{ id, shortcode, permalink, text?, timestamp? }`.
// We model both via a single permissive schema so the resolver can match by
// either `shortcode` (preferred) or `permalink` regardless of which endpoint
// served the response.

export const ThreadsProfilePost = z.object({
  id: z.string(),
  shortcode: z.string().optional(),
  permalink: z.string().optional(),
  text: z.string().optional(),
  timestamp: z.string().optional(),
  username: z.string().optional(),
  // Optional thread-kind flags. Present on `/me/threads` when requested
  // in the `fields` param; absent on `/profile_posts` responses.
  is_reply: z.boolean().optional(),
  is_quote_post: z.boolean().optional(),
  replied_to: z.object({ id: z.string() }).optional(),
  root_post: z.object({ id: z.string() }).optional(),
  media_type: z.string().optional(),
})
export type ThreadsProfilePost = z.infer<typeof ThreadsProfilePost>

export const ThreadsProfilePostsResponse = z.object({
  data: z.array(ThreadsProfilePost),
  paging: z
    .object({
      cursors: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
      next: z.string().optional(),
    })
    .optional(),
})
export type ThreadsProfilePostsResponse = z.infer<typeof ThreadsProfilePostsResponse>
