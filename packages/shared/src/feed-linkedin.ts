/** Portable LinkedIn intent and deterministic delivery contract. */
import { z } from 'zod'

export const FEED_LINKEDIN_PROJECTION_VERSION = 1 as const
export const FEED_LINKEDIN_VISIBLE_LIMIT = 3000
export function isFeedLinkedInSafeUrl(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password }
  catch { return false }
}
const reference = z.string().max(2048).refine(value => value === '' || isFeedLinkedInSafeUrl(value), 'Safe HTTP(S) URL required')
export const feedLinkedInContextSchema = z.object({
  version: z.literal(1), mode: z.enum(['post', 'link_post', 'newsletter_edition']),
  destinationId: z.string().uuid().nullable(), authorKind: z.enum(['person', 'organization']),
  authorDisplay: z.string().max(300).optional(),
  thumbnailFileId: z.string().uuid().nullable().optional(),
  newsletter: z.object({
    name: z.string().max(300), url: reference, editionTitle: z.string().max(2000),
    coverFileId: z.string().uuid().nullable().optional(), coverCaption: z.string().max(1000).optional(),
    launchCommentary: z.string().max(100_000).optional(),
  }).strict().optional(),
}).strict()
export type FeedLinkedInContext = z.infer<typeof feedLinkedInContextSchema>
export type FeedLinkedInIssue = { code: 'formatting_loss' | 'inline_attachments' | 'unfinished_slot' | 'unsupported_node' | 'unsafe_url' | 'empty_post' | 'text_limit' | 'media_limit' | 'duplicate_media' | 'article_fields' | 'media_link_conflict' | 'newsletter_fields' | 'invalid_thread'; blockId?: string }
export type FeedLinkedInProjection = {
  version: 1; mode: FeedLinkedInContext['mode'] | 'legacy_article';
  text: string; commentary: string; visibleLength: number; wireLength: number;
  media: Array<{ fileId: string; mimeType: string; alt: string; blockId: string; placement: 'inline' | 'attachment' }>;
  article?: { sourceUrl: string; title: string; description: string; thumbnailFileId?: string | null };
  context?: FeedLinkedInContext; warnings: FeedLinkedInIssue[]; blockers: FeedLinkedInIssue[];
}
export function feedLinkedInFileIds(context?: FeedLinkedInContext | null): string[] {
  return [...new Set([context?.thumbnailFileId, context?.newsletter?.coverFileId].filter((id): id is string => !!id))]
}

/** Token-free account metadata; absence on legacy Threads/X rows is expected. */
export type FeedLinkedInConnectionSummary = {
  destinationId?: string; authorKind?: 'person' | 'organization'; authorUrn?: string;
  connectionStatus?: string; canPublishAs?: boolean;
  capabilities?: { post: boolean; link_post: boolean; newsletter_edition: false };
}
