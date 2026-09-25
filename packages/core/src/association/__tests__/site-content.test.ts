/** [COMP:crm/site-content] Website content collection schemas, checks and projections. */
import { describe, expect, it } from 'vitest'
import { AssociationCommandSchema, ASSOCIATION_READ_COMMANDS } from '../operations.js'
import { parseSiteContent, resolveSiteContent, siteContentPublicationIssues, SITE_CONTENT_COLLECTIONS, SITE_CONTENT_READERS } from '../site-content.js'

const L = (en: string, extra: Record<string, string> = {}) => ({ en, ...extra })
const MEDIA = '11111111-1111-4111-8111-111111111111'

describe('[COMP:crm/site-content] schemas', () => {
  it('accepts a people roster with library and site images, and keeps full-width punctuation as given', () => {
    const doc = parseSiteContent('people', { schemaVersion: 1, groups: [{ key: 'council', sites: ['oasa'], title: L('Council', { 'zh-Hant': '理事會（2025–2027）！' }), term: '2025 – 2027', order: 0,
      members: [{ id: 'jane-doe', name: 'Jane Doe', honorific: 'Dr.', affiliation: L('Example University'), image: { mediaId: MEDIA, alt: L('Jane Doe') } },
        { id: 'john-roe', name: 'John Roe', admittedOn: '2021-02-20', image: { src: '/media/people/john.jpg', alt: L('John Roe') } }] }] })
    expect(doc.groups[0].title['zh-Hant']).toBe('理事會（2025–2027）！')
    expect(doc.groups[0].members[0].honorific).toBe('Dr.')
  })

  it('rejects an image with both or neither source, unsafe links and unknown fields', () => {
    const partner = (logo: unknown, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, partners: [{ id: 'acme', name: 'Acme', logo, sites: ['sea'], order: 0, ...extra }] })
    expect(() => parseSiteContent('partners', partner({ mediaId: MEDIA, src: '/media/a.png', alt: L('A') }))).toThrow()
    expect(() => parseSiteContent('partners', partner({ alt: L('A') }))).toThrow()
    expect(() => parseSiteContent('partners', partner({ src: '//evil.test/a.png', alt: L('A') }))).toThrow()
    expect(() => parseSiteContent('partners', partner({ src: '/media/a.svg', alt: L('A') }))).toThrow()
    expect(() => parseSiteContent('partners', partner({ src: '/media/a.png', alt: L('A') }, { href: 'javascript:alert(1)' }))).toThrow()
    expect(() => parseSiteContent('partners', partner({ src: '/media/a.png', alt: L('A') }, { colour: 'red' }))).toThrow()
    expect(parseSiteContent('partners', partner({ src: '/media/a.png', alt: L('A') }, { href: 'https://acme.test' })).partners[0].active).toBe(true)
  })

  it('requires English on every localized field except news, which may be listed in Chinese only', () => {
    expect(() => parseSiteContent('partners', { schemaVersion: 1, partners: [{ id: 'a', name: 'A', logo: { src: '/media/a.png', alt: { 'zh-Hant': '標誌' } }, sites: ['sea'], order: 0 }] })).toThrow()
    const news = parseSiteContent('news', { schemaVersion: 1, items: [
      { id: 'hkcd', sites: ['sea'], kind: 'article', date: '2026-08-25', locales: ['zh-Hant', 'zh-Hans'], title: { 'zh-Hant': '「智用」AI工具', 'zh-Hans': '「智用」AI工具' } },
      { id: 'q4', sites: ['oasa'], kind: 'newsletter', date: '2021-10-28', title: { en: 'Q4 Newsletter' } },
      { id: 'bad', sites: ['sea'], kind: 'article', date: '2026-08-25', locales: ['en'], title: { 'zh-Hant': '只有中文' } }] })
    expect(news.items[1].locales).toEqual(['en', 'zh-Hant', 'zh-Hans'])
    expect(siteContentPublicationIssues('news', news)).toEqual(['News item bad needs a title for en'])
  })

  it('carries a translated display name per person and a category per news item', () => {
    const people = parseSiteContent('people', { schemaVersion: 1, groups: [{ key: 'directors', sites: ['sea'], title: L('Directors'), order: 0,
      members: [{ id: 'karen-li', name: 'Karen Li', localizedName: L('Karen Li', { 'zh-Hant': '李簡鳳玲', 'zh-Hans': '李简凤玲' }), role: L('Honourary Treasurer', { 'zh-Hant': '名譽司庫' }) }] }] })
    expect(people.groups[0].members[0].localizedName?.['zh-Hant']).toBe('李簡鳳玲')
    const news = parseSiteContent('news', { schemaVersion: 1, items: [
      { id: 'report', sites: ['sea'], kind: 'publication', date: '2026-06-30', title: L('Industry outlook'), category: L('Industry Report', { 'zh-Hant': '行業報告' }) }] })
    expect(news.items[0].category?.en).toBe('Industry Report')
    expect(() => parseSiteContent('news', { schemaVersion: 1, items: [
      { id: 'x', sites: ['sea'], kind: 'article', date: '2026-06-30', title: L('X'), category: { 'zh-Hant': '只有中文' } }] })).toThrow()
  })
})

describe('[COMP:crm/site-content] publication issues', () => {
  it('reports duplicates and missing required copy per collection', () => {
    const people = parseSiteContent('people', { schemaVersion: 1, groups: [
      { key: 'council', sites: ['oasa'], title: L(''), order: 0, members: [{ id: 'a', name: 'A' }, { id: 'a', name: 'A again' }] },
      { key: 'council', sites: ['sea'], title: L('Council'), order: 1, members: [] }] })
    expect(siteContentPublicationIssues('people', people)).toEqual(['Group key council is used twice', 'Group council needs an English title', 'council: person a is listed twice'])
    const settings = parseSiteContent('settings', { schemaVersion: 1, sites: {} })
    expect(siteContentPublicationIssues('settings', settings)).toEqual(['Add settings for at least one site'])
    const news = parseSiteContent('news', { schemaVersion: 1, items: [{ id: 'x', sites: ['oasa'], kind: 'press', date: '2026-05-22', title: L('Launch'), href: '/press', fileId: MEDIA }] })
    expect(siteContentPublicationIssues('news', news)).toEqual(['News item x: choose a link or a file, not both'])
  })
})

describe('[COMP:crm/site-content] per-site projection', () => {
  it('filters by site, drops inactive partners and orders entries', () => {
    const partners = parseSiteContent('partners', { schemaVersion: 1, partners: [
      { id: 'b', name: 'B', logo: { src: '/media/b.png', alt: L('B') }, sites: ['oasa', 'sea'], order: 2 },
      { id: 'a', name: 'A', logo: { src: '/media/a.png', alt: L('A') }, sites: ['oasa'], order: 1 },
      { id: 'c', name: 'C', logo: { src: '/media/c.png', alt: L('C') }, sites: ['oasa'], order: 0, active: false },
      { id: 'd', name: 'D', logo: { src: '/media/d.png', alt: L('D') }, sites: ['sea'], order: 0 }] })
    expect((resolveSiteContent('partners', partners, 'oasa') as typeof partners).partners.map(p => p.id)).toEqual(['a', 'b'])
    const news = parseSiteContent('news', { schemaVersion: 1, items: [
      { id: 'old', sites: ['oasa'], kind: 'newsletter', date: '2021-10-28', title: L('Q4') },
      { id: 'new', sites: ['oasa'], kind: 'newsletter', date: '2022-10-06', title: L('Q3') }] })
    expect((resolveSiteContent('news', news, 'oasa') as typeof news).items.map(i => i.id)).toEqual(['new', 'old'])
    const settings = parseSiteContent('settings', { schemaVersion: 1, sites: {
      oasa: { contact: { email: 'info@oasahk.org', address: L('Hong Kong') }, legalLine: L('A trade name'), responseDays: 3 },
      sea: { contact: { email: 'info@seahk.org', address: L('Shatin') }, legalLine: L('SEA Ltd'), responseDays: 5 } } })
    expect(Object.keys((resolveSiteContent('settings', settings, 'sea') as typeof settings).sites)).toEqual(['sea'])
  })

  it('declares one reader per home page and both for shared collections', () => {
    expect(SITE_CONTENT_READERS['home-oasa']).toEqual(['oasa'])
    expect(SITE_CONTENT_READERS['home-sea']).toEqual(['sea'])
    for (const collection of SITE_CONTENT_COLLECTIONS) expect(SITE_CONTENT_READERS[collection].length).toBeGreaterThan(0)
  })
})

describe('[COMP:crm/site-content] commands', () => {
  it('parses the five commands, classifies reads, and refuses unknown collections', () => {
    for (const kind of ['site_content_draft', 'published_site_content', 'observe_site_content']) expect(ASSOCIATION_READ_COMMANDS).toContain(kind)
    expect(ASSOCIATION_READ_COMMANDS).not.toContain('save_site_content')
    expect(AssociationCommandSchema.parse({ kind: 'published_site_content', collection: 'people', site: 'sea' })).toMatchObject({ collection: 'people' })
    expect(() => AssociationCommandSchema.parse({ kind: 'site_content_draft', collection: 'secrets' })).toThrow()
    expect(AssociationCommandSchema.parse({ kind: 'save_site_content', collection: 'news', expectedVersion: 0, document: { schemaVersion: 1, items: [] } })).toMatchObject({ kind: 'save_site_content' })
  })
})
