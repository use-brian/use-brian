import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FeedComposition, FeedNode, FeedLinkedInContext } from '@use-brian/shared'
import { projectFeedLinkedIn, escapeLinkedInCommentary } from '../linkedin.js'
import { feedParagraph } from '../model.js'
const composition = (...content: FeedNode[]): FeedComposition => ({ version: 1, segments: [{ id: randomUUID(), content }] })
const context = (mode: FeedLinkedInContext['mode'] = 'post'): FeedLinkedInContext => ({ version: 1, mode, destinationId: null, authorKind: 'person' })
const image = (placement: 'inline' | 'attachment' = 'inline'): FeedNode => ({ type: 'image', attrs: { id: randomUUID(), fileId: randomUUID(), mimeType: 'image/png', alt: 'Orchard', placement } })
describe('[COMP:feed/linkedin-projection] canonical LinkedIn conversion', () => {
  it('preserves paragraphs, headings, breaks, nested ordering and quote text', () => {
    const doc = composition({ type: 'heading', attrs: { id: randomUUID(), level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
      { type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'First' }, { type: 'hardBreak' }, { type: 'text', text: 'Second' }] },
      { type: 'orderedList', attrs: { id: randomUUID(), start: 3 }, content: [{ type: 'listItem', attrs: { id: randomUUID() }, content: [feedParagraph('Fruit'), { type: 'bulletList', attrs: { id: randomUUID() }, content: [{ type: 'listItem', attrs: { id: randomUUID() }, content: [feedParagraph('Apple')] }] }] }] },
      { type: 'blockquote', attrs: { id: randomUUID() }, content: [feedParagraph('Quoted')] })
    expect(projectFeedLinkedIn(doc).text).toBe('Heading\n\nFirst\nSecond\n\n3. Fruit\n  • Apple\n\n› Quoted')
  })
  it('removes styling with notice and preserves link destinations', () => {
    const doc = composition({ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'Read', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'link', attrs: { href: 'https://example.com/story' } }] }] })
    const result = projectFeedLinkedIn(doc)
    expect(result.text).toBe('Read (https://example.com/story)'); expect(result.warnings.map(i => i.code)).toEqual(['formatting_loss'])
    expect(projectFeedLinkedIn(doc)).toEqual(result)
  })
  it('escapes literal reserved punctuation exactly once from canonical text', () => {
    const text = '|{}@[]()<>#\\*_~'
    const result = projectFeedLinkedIn(composition(feedParagraph(text)))
    expect(result.commentary).toBe([...text].map(c => '\\' + c).join(''))
    expect(result.visibleLength).toBe(text.length); expect(result.wireLength).toBe(text.length * 2)
    expect(escapeLinkedInCommentary('hello')).toBe('hello')
  })
  it.each(['字'.repeat(3000), '😀'.repeat(1500), 'e\u0301'.repeat(1500)])('uses the named UTF-16 boundary without truncation', text => {
    expect(projectFeedLinkedIn(composition(feedParagraph(text))).blockers).toEqual([])
    const over = projectFeedLinkedIn(composition(feedParagraph(text + 'x')))
    expect(over.blockers).toContainEqual({ code: 'text_limit' }); expect(over.text).toBe(text + 'x')
  })
  it('blocks empty content, placeholders and unknown nodes instead of silently publishing', () => {
    expect(projectFeedLinkedIn(composition(feedParagraph(''))).blockers).toContainEqual({ code: 'empty_post' })
    const slot: FeedNode = { type: 'generationPlaceholder', attrs: { id: randomUUID(), kind: 'text', brief: 'Write', briefRevision: 0, references: [] } }
    expect(projectFeedLinkedIn(composition(feedParagraph('Public'), slot)).blockers).toContainEqual({ code: 'unfinished_slot', blockId: slot.attrs.id })
    expect(projectFeedLinkedIn(composition({ type: 'script', attrs: { id: randomUUID() } } as unknown as FeedNode)).blockers[0]?.code).toBe('unsupported_node')
  })
  it('blocks credentials and unsafe link schemes', () => {
    for (const href of ['https://user:secret@example.com/', 'javascript:alert(1)']) {
      const result = projectFeedLinkedIn(composition({ type: 'paragraph', attrs: { id: randomUUID() }, content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href } }] }] }))
      expect(result.blockers.length).toBeGreaterThan(0)
    }
  })
  it('preserves ordered assets and alt text, and reports inline placement loss', () => {
    const first = image(); const second = image('attachment'); const result = projectFeedLinkedIn(composition(first, feedParagraph('Gallery'), second))
    expect(result.media.map(m => m.blockId)).toEqual([first.attrs.id, second.attrs.id]); expect(result.media.map(m => m.alt)).toEqual(['Orchard', 'Orchard'])
    expect(result.text).toBe('Gallery'); expect(result.warnings).toContainEqual({ code: 'inline_attachments' })
  })
  it('keeps link cards separate from media and newsletter editions', () => {
    const article = { sourceUrl: 'https://example.com/story', title: 'Story', description: 'Description' }
    expect(projectFeedLinkedIn(composition(feedParagraph('Read'), image()), context('link_post'), { article }).blockers).toContainEqual({ code: 'media_link_conflict' })
    const result = projectFeedLinkedIn(composition(feedParagraph('字'.repeat(4000))), { ...context('newsletter_edition'), newsletter: { name: 'Orchard', url: 'https://www.linkedin.com/newsletters/123456789', editionTitle: 'Edition' } })
    expect(result.mode).toBe('newsletter_edition'); expect(result.blockers).toEqual([])
    expect(projectFeedLinkedIn(composition(feedParagraph('Edition')), context('newsletter_edition')).blockers).toContainEqual({ code: 'newsletter_fields' })
  })
  it('preserves legacy article export without inventing a newsletter identity', () => {
    expect(projectFeedLinkedIn(composition(feedParagraph('Article'), image()), undefined, { postFormat: 'article' }).mode).toBe('legacy_article')
    expect(projectFeedLinkedIn(composition(feedParagraph('Article')), undefined, { postFormat: 'article' }).mode).toBe('link_post')
  })
})
