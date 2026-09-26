/** One projection for preview, validation, export and provider delivery. [COMP:feed/linkedin-projection] */
import { FEED_LINKEDIN_PROJECTION_VERSION, FEED_LINKEDIN_VISIBLE_LIMIT, isFeedLinkedInSafeUrl, feedLinkedInContextSchema,
  type FeedComposition, type FeedNode, type FeedInline, type FeedLinkedInContext, type FeedLinkedInProjection, type FeedLinkedInIssue } from '@use-brian/shared'
import { validateFeedComposition } from './model.js'

/** Always starts from literal canonical text, never a previous wire projection. */
export function escapeLinkedInCommentary(text: string): string { return text.replace(/[|{}@\[\]()<>#\\*_~]/g, '\\$&') }
export function projectFeedLinkedIn(composition: FeedComposition, context?: FeedLinkedInContext, legacy?: {
  postFormat?: string; article?: { sourceUrl: string; title: string; description: string };
}): FeedLinkedInProjection {
  const warnings: FeedLinkedInIssue[] = []; const blockers: FeedLinkedInIssue[] = []
  const media: FeedLinkedInProjection['media'] = []
  const issue = (list: FeedLinkedInIssue[], code: FeedLinkedInIssue['code'], blockId?: string) => {
    if (!list.some(item => item.code === code && item.blockId === blockId)) list.push({ code, ...(blockId ? { blockId } : {}) })
  }
  try { validateFeedComposition(composition); if (context) feedLinkedInContextSchema.parse(context) }
  catch { return { version: 1, mode: context?.mode ?? 'post', text: '', commentary: '', visibleLength: 0, wireLength: 0, media, warnings, blockers: [{ code: 'unsupported_node' }] } }
  const inline = (nodes: FeedInline[], blockId: string) => nodes.map(node => {
    if (node.type === 'hardBreak') return '\n'
    let text = node.text
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') {
        if (!isFeedLinkedInSafeUrl(mark.attrs.href)) issue(blockers, 'unsafe_url', blockId)
        else if (text !== mark.attrs.href) text += ` (${mark.attrs.href})`
      } else issue(warnings, 'formatting_loss', blockId)
    }
    return text
  }).join('')
  const render = (node: FeedNode, depth = 0): string => {
    switch (node.type) {
      case 'paragraph': case 'heading': return inline(node.content ?? [], node.attrs.id)
      case 'generationPlaceholder': issue(blockers, 'unfinished_slot', node.attrs.id); return ''
      case 'image': media.push({ fileId: node.attrs.fileId, mimeType: node.attrs.mimeType, alt: node.attrs.alt ?? '', blockId: node.attrs.id, placement: node.attrs.placement }); return ''
      case 'blockquote': return node.content.map(n => render(n, depth)).join('\n\n').split('\n').map(line => '› ' + line).join('\n')
      case 'listItem': return node.content.map(n => render(n, depth)).filter(Boolean).join('\n')
      case 'bulletList': case 'orderedList': return node.content.map((n, i) => {
        const prefix = '  '.repeat(depth) + (node.type === 'orderedList' ? `${node.attrs.start + i}. ` : '• ')
        return prefix + render(n, depth + 1)
      }).join('\n')
      default: issue(blockers, 'unsupported_node'); return ''
    }
  }
  const text = composition.segments.map(s => s.content.map(n => render(n)).filter(Boolean).join('\n\n')).join('\n\n')
  const mode = context?.mode ?? (legacy?.postFormat === 'article' ? media.some(m => m.placement === 'inline') ? 'legacy_article' : 'link_post' : 'post')
  const manual = mode === 'newsletter_edition' || mode === 'legacy_article'
  if (composition.segments.length !== 1) issue(blockers, 'invalid_thread')
  if (!text.trim() && !media.length) issue(blockers, 'empty_post')
  if (!manual && text.length > FEED_LINKEDIN_VISIBLE_LIMIT) issue(blockers, 'text_limit')
  if (media.length > 20) issue(blockers, 'media_limit')
  if (new Set(media.map(m => m.fileId)).size !== media.length) issue(blockers, 'duplicate_media')
  if (!manual && media.some(m => m.placement === 'inline')) issue(warnings, 'inline_attachments')
  let article: FeedLinkedInProjection['article']
  if (mode === 'link_post') {
    if (!legacy?.article?.title.trim() || !isFeedLinkedInSafeUrl(legacy?.article?.sourceUrl ?? '')) issue(blockers, 'article_fields')
    if (media.length) issue(blockers, 'media_link_conflict')
    if (legacy?.article) article = { ...legacy.article, thumbnailFileId: context?.thumbnailFileId }
  }
  if (mode === 'newsletter_edition' && (!context?.newsletter?.name.trim() || !context.newsletter.editionTitle.trim() || !isFeedLinkedInSafeUrl(context.newsletter.url))) issue(blockers, 'newsletter_fields')
  const commentary = escapeLinkedInCommentary(text)
  return { version: FEED_LINKEDIN_PROJECTION_VERSION, mode, text, commentary, visibleLength: text.length, wireLength: commentary.length, media, ...(article ? { article } : {}), ...(context ? { context } : {}), warnings, blockers }
}
