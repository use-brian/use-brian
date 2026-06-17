/**
 * Zod schemas for X (Twitter) API v2 responses.
 *
 * Only fields we consume are modeled; extras are tolerated.
 * See docs/architecture/feed/twitter.md.
 */

import { z } from 'zod'

// ── OAuth responses ─────────────────────────────────────────────

export const TwitterTokenResponse = z.object({
  token_type: z.string(),
  access_token: z.string(),
  refresh_token: z.string().optional(),   // Present when scope includes offline.access
  expires_in: z.number(),                 // seconds — ~7200 (2h) for user-context tokens
  scope: z.string(),                      // space-separated list of granted scopes
})
export type TwitterTokenResponse = z.infer<typeof TwitterTokenResponse>

// ── Profile ─────────────────────────────────────────────────────

export const TwitterProfile = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional(),
  profile_image_url: z.string().optional(),
})
export type TwitterProfile = z.infer<typeof TwitterProfile>

// ── Tweets ──────────────────────────────────────────────────────

export const TwitterPublicMetrics = z.object({
  retweet_count: z.number().optional(),
  reply_count: z.number().optional(),
  like_count: z.number().optional(),
  quote_count: z.number().optional(),
  impression_count: z.number().optional(),
  bookmark_count: z.number().optional(),
})
export type TwitterPublicMetrics = z.infer<typeof TwitterPublicMetrics>

/**
 * `referenced_tweets[].type`: 'retweeted' | 'quoted' | 'replied_to'.
 * The voice-import filter drops 'retweeted' (RTs) entirely and drops
 * 'quoted' when the surrounding text is empty.
 */
export const TwitterReferencedTweet = z.object({
  type: z.enum(['retweeted', 'quoted', 'replied_to']),
  id: z.string(),
})
export type TwitterReferencedTweet = z.infer<typeof TwitterReferencedTweet>

export const TwitterTweetAttachments = z.object({
  media_keys: z.array(z.string()).optional(),
}).partial()

export const TwitterTweet = z.object({
  id: z.string(),
  text: z.string().optional(),
  author_id: z.string().optional(),
  conversation_id: z.string().optional(),
  created_at: z.string().optional(),
  in_reply_to_user_id: z.string().optional(),
  public_metrics: TwitterPublicMetrics.optional(),
  referenced_tweets: z.array(TwitterReferencedTweet).optional(),
  attachments: TwitterTweetAttachments.optional(),
})
export type TwitterTweet = z.infer<typeof TwitterTweet>

export const TwitterCreateTweetResponse = z.object({
  data: z.object({
    id: z.string(),
    text: z.string().optional(),
  }),
})
export type TwitterCreateTweetResponse = z.infer<typeof TwitterCreateTweetResponse>

export const TwitterSingleTweetResponse = z.object({
  data: TwitterTweet,
})
export type TwitterSingleTweetResponse = z.infer<typeof TwitterSingleTweetResponse>

export const TwitterTweetWithIncludesResponse = z.object({
  data: TwitterTweet,
  includes: z
    .object({
      users: z.array(TwitterProfile).optional(),
    })
    .optional(),
})
export type TwitterTweetWithIncludesResponse = z.infer<typeof TwitterTweetWithIncludesResponse>

export const TwitterTweetListResponse = z.object({
  data: z.array(TwitterTweet).optional(),   // Absent when zero results
  // Present only when the request asked for `expansions=author_id` — maps
  // each tweet's numeric `author_id` to a handle/display name.
  includes: z
    .object({
      users: z.array(TwitterProfile).optional(),
    })
    .optional(),
  meta: z.object({
    result_count: z.number().optional(),
    newest_id: z.string().optional(),
    oldest_id: z.string().optional(),
    next_token: z.string().optional(),
  }).optional(),
})
export type TwitterTweetListResponse = z.infer<typeof TwitterTweetListResponse>

export const TwitterDeleteResponse = z.object({
  data: z.object({
    deleted: z.boolean(),
  }),
})
export type TwitterDeleteResponse = z.infer<typeof TwitterDeleteResponse>

export const TwitterHideResponse = z.object({
  data: z.object({
    hidden: z.boolean(),
  }),
})
export type TwitterHideResponse = z.infer<typeof TwitterHideResponse>

export const TwitterProfileResponse = z.object({
  data: TwitterProfile,
})
export type TwitterProfileResponse = z.infer<typeof TwitterProfileResponse>

// ── Lists ───────────────────────────────────────────────────────

export const TwitterList = z.object({
  id: z.string(),
  name: z.string(),
  member_count: z.number().optional(),
  follower_count: z.number().optional(),
  private: z.boolean().optional(),
  description: z.string().optional(),
  owner_id: z.string().optional(),
})
export type TwitterList = z.infer<typeof TwitterList>

export const TwitterListResponse = z.object({
  data: z.array(TwitterList).optional(),
  meta: z.object({
    result_count: z.number().optional(),
    next_token: z.string().optional(),
  }).optional(),
})
export type TwitterListResponse = z.infer<typeof TwitterListResponse>
