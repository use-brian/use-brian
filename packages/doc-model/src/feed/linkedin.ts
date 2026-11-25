/** One projection for preview, validation, export and provider delivery. [COMP:feed/linkedin-projection] */
import { FEED_LINKEDIN_PROJECTION_VERSION, FEED_LINKEDIN_VISIBLE_LIMIT, isFeedLinkedInSafeUrl, feedLinkedInContextSchema,
  type FeedComposition, type FeedNode, type FeedInline, type FeedLinkedInContext, type FeedLinkedInProjection, type FeedLinkedInIssue } from '@use-brian/shared'
import { validateFeedComposition } from './model.js'

/** Always starts from literal canonical text, never a previous wire projection. */
export function escapeLinkedInCommentary(text: string): string { return text.replace(/[|{}@\[\]()<>#\\*_~]/g, '\\$&') }
export function projectFeedLinkedIn(composition: FeedComposition, context?: FeedLinkedInContext, legacy?: {
  postFormat?: string; article?: { sourceUrl: string; title: string; description: string };
}, onBlockLine?: (blockId: string, line: number) => void): FeedLinkedInProjection {
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
  // LinkedIn flattens rich text. Keep optional editor anchors alongside the
  // projection without adding local presentation data to the delivery payload.
  const joinBlocks = (nodes: FeedNode[], separator: string, depth: number, firstLine: number,
    skipEmpty: boolean, prefix?: (index: number) => string): string => {
    const parts: string[] = []
    let line = firstLine
    for (const [index, node] of nodes.entries()) {
      const part = (prefix?.(index) ?? '') + render(node, depth, line)
      if (part || !skipEmpty) {
        parts.push(part)
        if (onBlockLine) line += part.split('\n').length - 1 + separator.length
      }
    }
    return parts.join(separator)
  }
  const render = (node: FeedNode, depth: number, line: number): string => {
    if (node.type !== 'image' && node.type !== 'generationPlaceholder') onBlockLine?.(node.attrs.id, line)
    switch (node.type) {
      case 'paragraph': case 'heading': return inline(node.content ?? [], node.attrs.id)
      case 'generationPlaceholder': issue(blockers, 'unfinished_slot', node.attrs.id); return ''
      case 'image': media.push({ fileId: node.attrs.fileId, mimeType: node.attrs.mimeType, alt: node.attrs.alt ?? '', blockId: node.attrs.id, placement: node.attrs.placement }); return ''
      case 'blockquote': return joinBlocks(node.content, '\n\n', depth, line, false).split('\n').map(line => '› ' + line).join('\n')
      case 'listItem': return joinBlocks(node.content, '\n', depth, line, true)
      case 'bulletList': case 'orderedList': return joinBlocks(node.content, '\n', depth + 1, line, false,
        i => '  '.repeat(depth) + (node.type === 'orderedList' ? `${node.attrs.start + i}. ` : '• '))
      default: issue(blockers, 'unsupported_node'); return ''
    }
  }
  let firstLine = 0
  const text = composition.segments.map(segment => {
    const body = joinBlocks(segment.content, '\n\n', 0, firstLine, true)
    if (onBlockLine) firstLine += body.split('\n').length + 1
    return body
  }).join('\n\n')
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
