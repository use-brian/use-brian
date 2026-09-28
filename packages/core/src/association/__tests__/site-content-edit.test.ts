import { describe, expect, it } from 'vitest'
import { applySiteContentOperations, eventPageOperations, EventPageEditSchema, siteContentChanges, siteContentMediaIds, siteContentOutline, siteContentValueAt } from '../site-content-edit.js'
import { parseSiteContent, SITE_CONTENT_COLLECTIONS } from '../site-content.js'
import { preserveCompatText, restoreCompatText } from '../compat-text.js'

const L = (en: string) => ({ en })
const media = '00000000-0000-4000-8000-000000000001'
const pages = () => ({ schemaVersion: 1, pages: [
  { event: 'space-night', summary: L('An evening'), sections: [
    { id: 'intro', kind: 'text', hidden: false, body: L('Welcome') },
    { id: 'speakers', kind: 'speakers', hidden: false, people: [{ name: 'Example Speaker' }] },
  ] },
  { event: 'other-talk', sections: [] },
] })

describe('[COMP:crm/site-content] item-level edits', () => {
  it('addresses entries by reference or position and leaves every other entry untouched', () => {
    const before = pages()
    const { document, changed } = applySiteContentOperations('event-pages', before, [
      { op: 'set', path: 'pages/space-night/sections/speakers/people/0/title', value: L('Astronomer') },
      { op: 'insert', path: 'pages/space-night/sections/speakers/people', value: { name: 'Second Speaker' } },
      { op: 'move', path: 'pages/space-night/sections/speakers', index: 0 },
      { op: 'remove', path: 'pages/space-night/summary' },
    ])
    expect(parseSiteContent('event-pages', document)).toMatchObject({ pages: [{ event: 'space-night', sections: [
      { id: 'speakers', people: [{ name: 'Example Speaker', title: { en: 'Astronomer' } }, { name: 'Second Speaker' }] }, { id: 'intro' }] }, { event: 'other-talk' }] })
    expect(siteContentValueAt(document, 'pages/space-night/summary')).toBeUndefined()
    expect(before.pages[0]!.summary).toEqual(L('An evening'))
    expect(changed).toHaveLength(4)
  })
  it('decodes JSON text a model sends for a structured value, but keeps real text as text', () => {
    const { document } = applySiteContentOperations('event-pages', pages(), [
      { op: 'set', path: 'pages/space-night/summary', value: '{"en":"Decoded"}' },
      { op: 'set', path: 'pages/space-night/sections/intro/hidden', value: 'true' },
      { op: 'insert', path: 'pages/space-night/sections', value: '{"id":"faq","kind":"faq","items":[]}' },
      { op: 'set', path: 'pages/space-night/sections/speakers/people/0/name', value: '2024' },
    ])
    expect(parseSiteContent('event-pages', document).pages[0]).toMatchObject({ summary: { en: 'Decoded' },
      sections: [{ id: 'intro', hidden: true }, { id: 'speakers', people: [{ name: '2024' }] }, { id: 'faq' }] })
  })
  it('refuses edits that address nothing or duplicate a reference, and starts list collections empty', () => {
    expect(() => applySiteContentOperations('event-pages', pages(), [{ op: 'set', path: 'pages/missing/summary', value: L('x') }])).toThrow(/Nothing at pages\/missing/)
    expect(() => applySiteContentOperations('event-pages', pages(), [{ op: 'insert', path: 'pages', value: { event: 'other-talk', sections: [] } }])).toThrow(/use set/)
    expect(() => applySiteContentOperations(SITE_CONTENT_COLLECTIONS.find(name => name.startsWith('home-'))!, null, [{ op: 'set', path: 'hero/title', value: L('x') }])).toThrow(/Save the whole page/)
    expect(applySiteContentOperations('partners', null, [{ op: 'insert', path: 'partners', value: { id: 'acme' } }]).document).toEqual({ schemaVersion: 1, partners: [{ id: 'acme' }] })
  })
  it('turns an event page edit into operations, creating the page and placing sections after a reference', () => {
    const edit = EventPageEditSchema.parse({ eventSlug: 'new-event', expectedVersion: 3, cover: { mediaId: media, alt: L('Stage') },
      sections: [{ op: 'add', section: { id: 'intro', kind: 'text', body: L('Hello') } }, { op: 'add', after: 'intro', section: { id: 'faq', kind: 'faq', items: [] } }, { op: 'add', after: 'start', section: { id: 'first', kind: 'text', body: L('First') } }] })
    const { document } = applySiteContentOperations('event-pages', pages(), eventPageOperations(pages(), edit))
    expect(parseSiteContent('event-pages', document).pages[2]).toMatchObject({ event: 'new-event', cover: { mediaId: media }, sections: [{ id: 'first' }, { id: 'intro' }, { id: 'faq' }] })
    const hide = EventPageEditSchema.parse({ eventSlug: 'space-night', expectedVersion: 3, clear: ['summary', 'cover'], sections: [{ op: 'hide', id: 'intro', hidden: true }, { op: 'remove', id: 'speakers' }] })
    expect(parseSiteContent('event-pages', applySiteContentOperations('event-pages', pages(), eventPageOperations(pages(), hide)).document).pages[0]!.sections)
      .toEqual([{ id: 'intro', kind: 'text', hidden: true, body: L('Welcome') }])
    expect(() => eventPageOperations(pages(), EventPageEditSchema.parse({ eventSlug: 'space-night', expectedVersion: 3 }))).toThrow(/Nothing to change/)
  })
  it('collects library ids and describes what publishing changes, whatever the key order', () => {
    expect(siteContentMediaIds({ pages: [{ cover: { mediaId: media, alt: L('x') } }], items: [{ fileId: media }] })).toEqual([media])
    const published = pages(), draft = pages()
    draft.pages[0]!.summary = L('Changed')
    draft.pages.reverse()
    draft.pages.push({ event: 'added-event', sections: [] })
    expect(siteContentChanges(published, draft)).toEqual(['changed pages/space-night', 'added pages/added-event', 'reordered pages'])
    expect(siteContentChanges({ hero: { title: L('a'), body: L('b') } }, { hero: { body: L('b'), title: L('a') } })).toEqual([])
    expect(siteContentOutline(pages())).toEqual({ schemaVersion: 1, pages: [{ ref: 'space-night', sections: ['intro (text)', 'speakers (speakers)'] }, { ref: 'other-talk', sections: [] }] })
  })
  it('round-trips compatibility characters through the stored escapes', () => {
    const text = { en: 'Non‑breaking（香港）\\ path' }
    expect(JSON.stringify(preserveCompatText(text))).not.toContain('‑')
    expect(restoreCompatText(preserveCompatText(text))).toEqual(text)
  })
})
