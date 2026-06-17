/**
 * Platform-agnostic shapes shared across feed/* sub-modules.
 *
 * Voice learning + inspiration scanning both consume per-platform read
 * endpoints (X today, Threads later) and pass results into platform-agnostic
 * skill recipes. Defining the canonical output shapes here keeps the skills
 * tool-agnostic — when Threads adds parallel tools, they return the same
 * shape and the same skill drives both.
 *
 * See docs/architecture/feed/voice-learning.md and
 * docs/architecture/feed/inspiration-feed.md.
 */

import { z } from 'zod'

/** Platforms exposing voice / inspiration tooling. */
export const FeedPlatform = z.enum(['twitter', 'threads'])
export type FeedPlatform = z.infer<typeof FeedPlatform>

// ── Voice learning ──────────────────────────────────────────────

/**
 * A single original post pulled from the connected handle's recent
 * timeline. Voice import accumulates ~50–150 of these (after RT / reply /
 * pure-media filtering) and feeds them to the analysis prompt.
 */
export const VoiceSample = z.object({
  platform: FeedPlatform,
  externalId: z.string(),
  text: z.string(),
  publishedAt: z.string(),     // ISO timestamp
  engagement: z.object({
    likes: z.number().optional(),
    reposts: z.number().optional(),
    replies: z.number().optional(),
  }),
  /** Platform-specific extras (e.g. X conversation_id, Threads carousel info). */
  platformMeta: z.record(z.unknown()).optional(),
})
export type VoiceSample = z.infer<typeof VoiceSample>

// ── Inspiration scanning ────────────────────────────────────────

/** Where an inspiration candidate came from. */
export const InspirationSource = z.enum([
  'timeline',
  'list',
  'search',
  'tracked-user',
])
export type InspirationSource = z.infer<typeof InspirationSource>

/**
 * A scored candidate post worth replying to, surfaced by the inspiration
 * scan skill. Cross-platform from day one — Threads parity returns the
 * same shape, so cross-platform dedup and ranking work for free.
 */
export const InspirationCandidate = z.object({
  platform: FeedPlatform,
  externalId: z.string(),
  text: z.string(),
  author: z.object({
    handle: z.string(),
    displayName: z.string().optional(),
    verified: z.boolean().optional(),
  }),
  publishedAt: z.string(),
  engagement: z.object({
    likes: z.number().optional(),
    reposts: z.number().optional(),
    replies: z.number().optional(),
  }),
  source: InspirationSource,
  /** One-line "why this one is worth a reply", produced by the scoring pass. */
  whyMatch: z.string().optional(),
  /** 0.0–1.0 ranking signal, surfaced for UI hints. */
  score: z.number().min(0).max(1).optional(),
  platformMeta: z.record(z.unknown()).optional(),
})
export type InspirationCandidate = z.infer<typeof InspirationCandidate>
