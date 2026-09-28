/**
 * Website content collections: typed documents an association's public sites
 * render, published through the same draft → preview → immutable revision →
 * per-site observation lifecycle as the membership and programme catalogues.
 * One keyed store holds every collection; each collection owns its schema,
 * publication checks and per-site projection here. Layout, navigation, forms
 * and UI chrome stay in the website code. [COMP:crm/site-content]
 */
import { z } from 'zod'
import { MembershipSiteSchema } from './membership-catalogue.js'
import { tolerantBoolean } from '../tools/schema-tolerance.js'

export const SITE_CONTENT_COLLECTIONS = ['people', 'partners', 'settings', 'news', 'home-oasa', 'home-sea', 'event-pages'] as const
export const SiteContentCollectionSchema = z.enum(SITE_CONTENT_COLLECTIONS)
export type SiteContentCollection = z.infer<typeof SiteContentCollectionSchema>
export type SiteContentSite = z.infer<typeof MembershipSiteSchema>
export const SITE_CONTENT_LOCALES = ['en', 'zh-Hant', 'zh-Hans'] as const
export type SiteContentLocale = (typeof SITE_CONTENT_LOCALES)[number]

const MAX_DOCUMENT_CHARS = 2_000_000
const short = z.string().trim().max(300)
const text = z.string().trim().max(20_000)
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Use lowercase letters, digits and hyphens')
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const href = z.string().max(2000).refine(value => !value.includes('\\') && (/^https:\/\/[^\s]+$/.test(value) || /^mailto:[^\s@]+@[^\s@]+$/.test(value) || /^\/(?!\/)[^\s]*$/.test(value)),
  'Use an HTTPS, mailto: or site-relative link')
const sites = z.array(MembershipSiteSchema).min(1).max(2)

/** English is required; a translation, when present, replaces English for that locale. */
const localized = (inner: z.ZodString) => z.object({ en: inner, 'zh-Hant': inner.optional(), 'zh-Hans': inner.optional() }).strict()
export const LocalizedShortSchema = localized(short)
export const LocalizedTextSchema = localized(text)
export type LocalizedText = z.infer<typeof LocalizedTextSchema>
const paragraphs = z.array(LocalizedTextSchema).max(40)

/** A library file (website media id) or, during migration, a file the site already ships. */
export const SiteImageSchema = z.object({
  mediaId: z.string().uuid().optional(),
  src: z.string().max(500).regex(/^\/(?!\/)[A-Za-z0-9._~%/-]+\.(?:jpe?g|png|webp|gif|avif)$/i, 'Use a site image path').optional(),
  alt: LocalizedShortSchema,
}).strict().refine(image => Boolean(image.mediaId) !== Boolean(image.src), 'Choose exactly one of a library image or a site path')
export type SiteImage = z.infer<typeof SiteImageSchema>
export const SiteLinkSchema = z.object({ label: LocalizedShortSchema, href }).strict()

// ── people ─────────────────────────────────────────────────────────────────
export const SitePersonSchema = z.object({
  id, name: short, honorific: short.default(''),
  /** Display name per language (e.g. a Chinese name on the Chinese pages); `name` stays the stable roll name. */
  localizedName: LocalizedShortSchema.optional(),
  role: LocalizedShortSchema.optional(), affiliation: LocalizedShortSchema.optional(), specialties: LocalizedShortSchema.optional(),
  admittedOn: date.optional(), image: SiteImageSchema.optional(), bio: LocalizedTextSchema.optional(),
}).strict()
export const PeopleDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  groups: z.array(z.object({
    key: id, sites, title: LocalizedShortSchema, intro: LocalizedTextSchema.optional(), term: short.default(''),
    order: z.number().int().min(0).max(10_000), members: z.array(SitePersonSchema).max(500),
  }).strict()).max(40),
}).strict()

// ── partners ───────────────────────────────────────────────────────────────
export const PartnersDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  partners: z.array(z.object({
    id, name: short, logo: SiteImageSchema, href: href.optional(), sites, active: z.boolean().default(true),
    order: z.number().int().min(0).max(10_000),
  }).strict()).max(500),
}).strict()

// ── settings ───────────────────────────────────────────────────────────────
export const SiteSettingsSchema = z.object({
  /** How staff tools name this website; code never hard-codes a site name. */
  name: LocalizedShortSchema.optional(),
  /** The site's public address; the console opens its draft preview page there (http only on loopback). */
  websiteUrl: z.string().max(200).regex(/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/, 'Use the site address, e.g. https://www.example.org').optional(),
  contact: z.object({
    email: z.string().email().max(200), phone: short.default(''), address: LocalizedTextSchema, hours: LocalizedShortSchema.optional(),
  }).strict(),
  legalLine: LocalizedShortSchema,
  social: z.array(SiteLinkSchema).max(20).default([]),
  responseDays: z.number().int().min(1).max(30),
  ymp: z.object({ open: z.boolean(), cohortLabel: LocalizedShortSchema }).strict().optional(),
  directory: z.array(z.object({
    id, name: short, role: LocalizedShortSchema, email: z.string().email().max(200).optional(), phone: short.optional(),
  }).strict()).max(50).default([]),
}).strict()
export const SettingsDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  sites: z.object({ oasa: SiteSettingsSchema.optional(), sea: SiteSettingsSchema.optional() }).strict(),
}).strict()

// ── news ───────────────────────────────────────────────────────────────────
export const NEWS_KINDS = ['newsletter', 'press', 'article', 'publication'] as const
// A news item may exist only in Chinese, so English is not structurally required
// here; publication requires text for every language the item is listed in.
const newsTitle = z.object({ en: short.default(''), 'zh-Hant': short.optional(), 'zh-Hans': short.optional() }).strict()
const newsText = z.object({ en: text.default(''), 'zh-Hant': text.optional(), 'zh-Hans': text.optional() }).strict()
export const NewsDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(z.object({
    id, sites, kind: z.enum(NEWS_KINDS), date,
    /** Which site languages list the item. Chinese-language coverage is often listed on the Chinese pages only. */
    locales: z.array(z.enum(SITE_CONTENT_LOCALES)).min(1).max(3).default([...SITE_CONTENT_LOCALES]),
    title: newsTitle, summary: newsText.optional(),
    /** Editorial label shown on the card, e.g. "Association News" or "Policy Paper". */
    category: LocalizedShortSchema.optional(),
    href: href.optional(), fileId: z.string().uuid().optional(), image: SiteImageSchema.optional(),
  }).strict()).max(1000),
}).strict()

// ── home pages ─────────────────────────────────────────────────────────────
const stat = z.object({ value: z.string().trim().max(20), suffix: z.string().trim().max(10).default(''), label: LocalizedShortSchema }).strict()
export const OasaHomeDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  hero: z.object({ kicker: LocalizedShortSchema, title: LocalizedShortSchema, body: LocalizedTextSchema, note: LocalizedShortSchema.optional(), noteStrong: LocalizedShortSchema.optional() }).strict(),
  stats: z.array(stat).max(8),
  about: z.object({ heading: LocalizedShortSchema, lead: LocalizedTextSchema }).strict(),
  principles: z.array(z.object({ name: LocalizedShortSchema, text: LocalizedTextSchema }).strict()).max(8),
  audiences: z.array(z.object({ key: z.enum(['students', 'schools', 'corporates']), name: LocalizedShortSchema, short: LocalizedShortSchema, focus: LocalizedShortSchema, image: SiteImageSchema.optional() }).strict()).max(3),
  programmes: z.array(z.object({ slug: id, name: LocalizedShortSchema, short: LocalizedShortSchema, description: LocalizedTextSchema, image: SiteImageSchema.optional() }).strict()).max(16),
  endorsement: z.object({ quote: LocalizedTextSchema, by: short, role: LocalizedShortSchema }).strict().optional(),
  testimonials: z.array(z.object({ quote: LocalizedTextSchema, name: short, detail: LocalizedShortSchema.optional() }).strict()).max(12),
  newsletter: z.object({ heading: LocalizedShortSchema, body: LocalizedTextSchema }).strict(),
  footer: z.object({ heading: LocalizedShortSchema }).strict(),
}).strict()
export const SeaHomeDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  hero: z.object({ eyebrow: LocalizedShortSchema, title: LocalizedShortSchema, mission: LocalizedTextSchema, image: SiteImageSchema }).strict(),
  foundation: z.object({ eyebrow: LocalizedShortSchema, title: LocalizedShortSchema, body: LocalizedTextSchema, poster: SiteImageSchema.optional(), posterHref: href.optional() }).strict(),
  stats: z.array(stat).max(8),
  chairman: z.object({
    name: short, role: LocalizedShortSchema, image: SiteImageSchema, eyebrow: LocalizedShortSchema, title: LocalizedShortSchema,
    paragraphs, quote: LocalizedTextSchema.optional(), closing: paragraphs.default([]),
  }).strict(),
  programmes: z.object({
    eyebrow: LocalizedShortSchema, title: LocalizedShortSchema, subtitle: LocalizedTextSchema,
    cards: z.array(z.object({ icon: z.string().regex(/^[a-z0-9-]{1,40}$/), title: LocalizedShortSchema, body: LocalizedTextSchema, href }).strict()).max(12),
  }).strict(),
  membership: z.object({ eyebrow: LocalizedShortSchema, title: LocalizedShortSchema, body: LocalizedTextSchema, actions: z.array(SiteLinkSchema).max(3) }).strict(),
}).strict()

// ── event pages ────────────────────────────────────────────────────────────
/** An event's public page: cover, summary and an ordered list of typed sections staff build like a site builder.
 * Keyed by the event slug; the event row (dates, venue, tickets, status) stays in the event catalogue. */
const eventSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'Use the event reference')
const sectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
const heading = LocalizedShortSchema.optional()
// `hidden` tolerates "true"/"false": assistant tool schemas may present a defaulted flag to the model as text.
const section = { id: sectionId, hidden: tolerantBoolean().default(false) }
export const EventSectionSchema = z.discriminatedUnion('kind', [
  z.object({ ...section, kind: z.literal('text'), heading, body: LocalizedTextSchema }).strict(),
  z.object({ ...section, kind: z.literal('image'), image: SiteImageSchema, caption: LocalizedShortSchema.optional() }).strict(),
  z.object({ ...section, kind: z.literal('gallery'), heading, images: z.array(SiteImageSchema).min(1).max(40) }).strict(),
  z.object({ ...section, kind: z.literal('speakers'), heading, people: z.array(z.object({
    name: short, title: LocalizedShortSchema.optional(), bio: LocalizedTextSchema.optional(), photo: SiteImageSchema.optional(),
  }).strict()).max(40) }).strict(),
  z.object({ ...section, kind: z.literal('partners'), heading, partners: z.array(z.object({
    name: short, logo: SiteImageSchema.optional(), href: href.optional(),
  }).strict()).max(60) }).strict(),
  z.object({ ...section, kind: z.literal('agenda'), heading, items: z.array(z.object({
    time: short, title: LocalizedShortSchema, detail: LocalizedTextSchema.optional(),
  }).strict()).max(60) }).strict(),
  z.object({ ...section, kind: z.literal('faq'), heading, items: z.array(z.object({
    question: LocalizedShortSchema, answer: LocalizedTextSchema,
  }).strict()).max(40) }).strict(),
])
export type EventSection = z.infer<typeof EventSectionSchema>
export const EventPagesDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  pages: z.array(z.object({
    event: eventSlug, cover: SiteImageSchema.optional(), summary: LocalizedTextSchema.optional(),
    sections: z.array(EventSectionSchema).max(40),
  }).strict()).max(2000),
}).strict()

const DOCUMENTS = {
  people: PeopleDocumentSchema, partners: PartnersDocumentSchema, settings: SettingsDocumentSchema,
  news: NewsDocumentSchema, 'home-oasa': OasaHomeDocumentSchema, 'home-sea': SeaHomeDocumentSchema,
  'event-pages': EventPagesDocumentSchema,
} as const
export type SiteContentDocuments = { [K in SiteContentCollection]: z.infer<(typeof DOCUMENTS)[K]> }
export type SiteContentDocument = SiteContentDocuments[SiteContentCollection]

/** Which sites read a collection at all; a home page belongs to one site. */
export const SITE_CONTENT_READERS: Record<SiteContentCollection, readonly SiteContentSite[]> = {
  people: ['oasa', 'sea'], partners: ['oasa', 'sea'], settings: ['oasa', 'sea'], news: ['oasa', 'sea'], 'home-oasa': ['oasa'], 'home-sea': ['sea'],
  // Every site may list events; each site shows the pages for the events it hosts.
  'event-pages': MembershipSiteSchema.options,
}

export function siteContentSchema<K extends SiteContentCollection>(collection: K): z.ZodType<SiteContentDocuments[K]> {
  const schema = DOCUMENTS[collection] as unknown as z.ZodType<SiteContentDocuments[K]>
  return schema.superRefine((document, ctx) => {
    if (JSON.stringify(document).length > MAX_DOCUMENT_CHARS) ctx.addIssue({ code: 'custom', message: 'Document exceeds 2 MB' })
  }) as unknown as z.ZodType<SiteContentDocuments[K]>
}
export function parseSiteContent<K extends SiteContentCollection>(collection: K, raw: unknown): SiteContentDocuments[K] {
  return siteContentSchema(collection).parse(raw)
}

const duplicates = (values: string[]) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))]
const blank = (value: LocalizedText | undefined) => !value || !value.en.trim()

/** A reason a draft cannot be published: a stable code and parameters the UI translates, plus the English message tools show. */
export type SiteContentIssue = { code: string; params: Record<string, string>; message: string }

export function siteContentPublicationIssueDetails(collection: SiteContentCollection, document: SiteContentDocument): SiteContentIssue[] {
  const issues: SiteContentIssue[] = []
  const add = (code: string, params: Record<string, string>, message: string) => { issues.push({ code, params, message }) }
  switch (collection) {
    case 'people': {
      const doc = document as SiteContentDocuments['people']
      for (const key of duplicates(doc.groups.map(group => group.key))) add('duplicate_group', { group: key }, `Group key ${key} is used twice`)
      for (const group of doc.groups) {
        if (blank(group.title)) add('group_needs_title', { group: group.key }, `Group ${group.key} needs an English title`)
        for (const person of duplicates(group.members.map(member => member.id))) add('duplicate_person', { group: group.key, person }, `${group.key}: person ${person} is listed twice`)
        for (const member of group.members) if (!member.name.trim()) add('person_needs_name', { group: group.key, person: member.id }, `${group.key}: person ${member.id} needs a name`)
      }
      break
    }
    case 'partners': {
      const doc = document as SiteContentDocuments['partners']
      for (const key of duplicates(doc.partners.map(partner => partner.id))) add('duplicate_partner', { partner: key }, `Partner ${key} is listed twice`)
      for (const partner of doc.partners) if (!partner.name.trim()) add('partner_needs_name', { partner: partner.id }, `Partner ${partner.id} needs a name`)
      break
    }
    case 'settings': {
      const doc = document as SiteContentDocuments['settings']
      if (!Object.values(doc.sites).some(Boolean)) add('settings_need_site', {}, 'Add settings for at least one site')
      for (const [site, settings] of Object.entries(doc.sites)) {
        if (!settings) continue
        if (blank(settings.contact.address)) add('site_needs_address', { site }, `${site.toUpperCase()}: add the contact address`)
        if (blank(settings.legalLine)) add('site_needs_legal_line', { site }, `${site.toUpperCase()}: add the legal line`)
        for (const key of duplicates(settings.directory.map(entry => entry.id))) add('duplicate_directory_entry', { site, entry: key }, `${site.toUpperCase()}: directory entry ${key} is listed twice`)
      }
      break
    }
    case 'news': {
      const doc = document as SiteContentDocuments['news']
      for (const key of duplicates(doc.items.map(item => item.id))) add('duplicate_news', { item: key }, `News item ${key} is listed twice`)
      for (const item of doc.items) {
        for (const locale of item.locales) {
          if (!item.title[locale]?.trim() && !item.title.en.trim()) add('news_needs_title', { item: item.id, locale }, `News item ${item.id} needs a title for ${locale}`)
        }
        if (item.href && item.fileId) add('news_link_or_file', { item: item.id }, `News item ${item.id}: choose a link or a file, not both`)
      }
      break
    }
    case 'home-oasa': {
      const doc = document as SiteContentDocuments['home-oasa']
      if (blank(doc.hero.title)) add('hero_needs_title', {}, 'Add the hero title')
      for (const key of duplicates(doc.audiences.map(audience => audience.key))) add('duplicate_audience', { audience: key }, `Audience ${key} is listed twice`)
      for (const key of duplicates(doc.programmes.map(programme => programme.slug))) add('duplicate_featured_programme', { programme: key }, `Programme ${key} is featured twice`)
      break
    }
    case 'event-pages': {
      const doc = document as SiteContentDocuments['event-pages']
      for (const key of duplicates(doc.pages.map(page => page.event))) add('duplicate_event_page', { event: key }, `Event ${key} has two pages`)
      for (const page of doc.pages) {
        for (const key of duplicates(page.sections.map(item => item.id))) add('duplicate_section', { event: page.event, section: key }, `${page.event}: section ${key} is used twice`)
        for (const item of page.sections) if (item.kind === 'text' && !item.body.en.trim()) add('section_needs_text', { event: page.event }, `${page.event}: a text section needs English text`)
      }
      break
    }
    case 'home-sea': {
      const doc = document as SiteContentDocuments['home-sea']
      if (blank(doc.hero.title)) add('hero_needs_title', {}, 'Add the hero title')
      if (!doc.chairman.paragraphs.length) add('chairman_message_needed', {}, "Add the chairman's message")
      break
    }
  }
  return issues
}

/** Human-readable reasons a draft cannot be published. Empty means publishable. */
export function siteContentPublicationIssues(collection: SiteContentCollection, document: SiteContentDocument): string[] {
  return siteContentPublicationIssueDetails(collection, document).map(issue => issue.message)
}

/** Published projection for one site: entries addressed to other sites are removed. */
export function resolveSiteContent(collection: SiteContentCollection, document: SiteContentDocument, site: SiteContentSite): SiteContentDocument {
  switch (collection) {
    case 'people': {
      const doc = document as SiteContentDocuments['people']
      return { ...doc, groups: doc.groups.filter(group => group.sites.includes(site)).sort((a, b) => a.order - b.order) }
    }
    case 'partners': {
      const doc = document as SiteContentDocuments['partners']
      return { ...doc, partners: doc.partners.filter(partner => partner.active && partner.sites.includes(site)).sort((a, b) => a.order - b.order) }
    }
    case 'settings': {
      const doc = document as SiteContentDocuments['settings']
      return { schemaVersion: 1, sites: doc.sites[site] ? { [site]: doc.sites[site] } : {} }
    }
    case 'news': {
      const doc = document as SiteContentDocuments['news']
      return { ...doc, items: doc.items.filter(item => item.sites.includes(site)).sort((a, b) => b.date.localeCompare(a.date)) }
    }
    default:
      return document
  }
}

export const SiteContentDraftSaveSchema = z.object({ expectedVersion: z.number().int().nonnegative(), document: z.unknown() }).strict()
export const SiteContentPublishSchema = z.object({ expectedVersion: z.number().int().positive() }).strict()
