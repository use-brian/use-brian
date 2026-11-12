/** Published business content shared by staff, assistants and websites. [COMP:crm/membership-catalogue] */
import { z } from 'zod'

export const MembershipLocaleSchema = z.enum(['en', 'zh-Hant', 'zh-Hans'])
export const MembershipSiteSchema = z.enum(['oasa', 'sea'])
const text = z.string().trim().max(20_000)
const key = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)
const href = z.string().max(2000).refine(value => !value.includes('\\') && ( /^https:\/\/[^\s]+$/.test(value) || /^\/(?!\/)[^\s]*$/.test(value)), 'Use an HTTPS or site-relative link')
export const MembershipDocumentLinkSchema = z.object({ label: text, href }).strict()
export const MembershipCopySchema = z.object({
  name: z.string().trim().max(200), summary: text, audience: text.default(''), badge: text.default(''),
  description: text.default(''), eligibility: z.string().trim().max(5000), benefits: z.array(z.string().trim().max(500)).max(50),
  actionLabel: text.default(''), billingLabel: text.default(''),
  documents: z.array(MembershipDocumentLinkSchema).max(30).default([]),
}).strict()
const translations = z.object({ en: MembershipCopySchema, 'zh-Hant': MembershipCopySchema, 'zh-Hans': MembershipCopySchema }).strict()
const overrideTranslations = z.object({en: MembershipCopySchema.partial().optional(), 'zh-Hant': MembershipCopySchema.partial().optional(), 'zh-Hans': MembershipCopySchema.partial().optional()}).strict()
export const MembershipOptionalFieldSchema = z.enum(['position', 'interests', 'special_request', 'proposer']);
const optionalApplicationFields = z.array(MembershipOptionalFieldSchema).max(4)
  .refine(fields => new Set(fields).size === fields.length, 'Application fields must be unique');

export const WebsiteMembershipPlanSchema = z.object({
  key, planId: z.string().uuid().optional(), currency: z.literal('HKD'),
  feeMinor: z.number().int().min(0).max(100_000_000),
  billingPeriod: z.enum(['one_time', 'annual', 'lifetime', 'manual']),
  activeFrom: z.string().datetime({ offset: true }).nullable().default(null),
  activeTo: z.string().datetime({ offset: true }).nullable().default(null),
  availability: z.enum(['public', 'invitation', 'enquiry', 'closed']),
  application: z.object({ type: z.enum(['application', 'enquiry']), proposerRequired: z.boolean(), codeOfConduct: z.literal(true), reviewPipeline: z.literal('charter-review').optional(), optionalFields: optionalApplicationFields.optional() }).strict(),
  sites: z.array(MembershipSiteSchema).max(2), group: key, order: z.number().int().min(0).max(10000),
  i18n: translations,
  overrides: z.object({ oasa: overrideTranslations.optional(), sea: overrideTranslations.optional() }).strict().default({}),
  promotionId: z.string().uuid().nullable().default(null),
}).strict()
export const MembershipSectionSchema = z.object({
  id: key, title: text, image: z.object({src:href,alt:text}).strict().optional(), paragraphs: z.array(text).max(100).default([]),
  bullets: z.array(text).max(100).default([]), documents: z.array(MembershipDocumentLinkSchema).max(30).default([]),
}).strict()
export const MembershipPageCopySchema = z.object({
  title: text, intro: text,
  groups: z.array(z.object({ id: key, title: text, intro: text }).strict()).max(20),
  sections: z.array(MembershipSectionSchema).max(40),
  newsletter: z.object({ name: text, summary: text, benefits: z.array(text).max(30), actionLabel: text }).strict().optional(),
}).strict()
const pageTranslations = z.object({ en: MembershipPageCopySchema, 'zh-Hant': MembershipPageCopySchema, 'zh-Hans': MembershipPageCopySchema }).strict()
export const MembershipCatalogueDocumentSchema = z.object({
  schemaVersion: z.literal(1), plans: z.array(WebsiteMembershipPlanSchema).max(200),
  pages: z.object({ oasa: pageTranslations, sea: pageTranslations }).strict(),
}).strict().superRefine((document, ctx) => {
  if (JSON.stringify(document).length > 2_000_000) ctx.addIssue({ code: "custom", message: "Catalogue exceeds 2 MB" })
  if (new Set(document.plans.map(plan => plan.key)).size !== document.plans.length) ctx.addIssue({ code: 'custom', path: ['plans'], message: 'Plan keys must be unique' })
  const ids = document.plans.flatMap(plan => plan.planId ? [plan.planId] : [])
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['plans'], message: 'Plan IDs must be unique' })
  for (const [index, plan] of document.plans.entries()) {
    if (plan.activeFrom && plan.activeTo && Date.parse(plan.activeTo) <= Date.parse(plan.activeFrom)) ctx.addIssue({ code: 'custom', path: ['plans', index, 'activeTo'], message: 'End must follow start' })
  }
})
export type MembershipCatalogueDocument = z.infer<typeof MembershipCatalogueDocumentSchema>
export type WebsiteMembershipPlan = z.infer<typeof WebsiteMembershipPlanSchema>
export type MembershipSite = z.infer<typeof MembershipSiteSchema>
export type MembershipLocale = z.infer<typeof MembershipLocaleSchema>
export const MembershipDraftSaveSchema = z.object({ expectedVersion: z.number().int().nonnegative(), document: MembershipCatalogueDocumentSchema }).strict()
export const MembershipPublishSchema = z.object({ expectedVersion: z.number().int().positive() }).strict()

/** Drafts may be incomplete. Publication requires complete copy in every visible locale. */
export function membershipPublicationIssues(document: MembershipCatalogueDocument): string[] {
  const issues: string[] = []
  for (const site of MembershipSiteSchema.options) for (const locale of MembershipLocaleSchema.options) {
    const page = document.pages[site][locale]
    if (!page.title.trim() || !page.intro.trim()) issues.push(`${site}/${locale}: page title and introduction required`)
    if (page.groups.some(group => !group.title.trim())) issues.push(`${site}/${locale}: group titles required`);
    if (page.sections.some(section => !section.title.trim() || section.documents.some(link => !link.label.trim()))) issues.push(`${site}/${locale}: section titles and document labels required`);
    if (new Set(page.sections.map(section => section.id)).size !== page.sections.length) issues.push(`${site}/${locale}: duplicate section`);
    for (const section of page.sections) for (const paragraph of section.paragraphs) for (const reference of paragraph.matchAll(/\{(?:fee|promo):([a-z][a-z0-9-]*)\}/g)) {
      if (!document.plans.some(plan => plan.key === reference[1] && plan.sites.includes(site))) issues.push(`${site}/${locale}: unknown visible plan reference ${reference[1]}`);
    }
    const groups = new Set(page.groups.map(group => group.id))
    if (groups.size !== page.groups.length) issues.push(`${site}/${locale}: duplicate group`)
    for (const plan of document.plans) {
      const copy = {...plan.i18n[locale],...plan.overrides[site]?.[locale]}
      if (!copy.name.trim() || !copy.summary.trim() || !copy.eligibility.trim() || !copy.benefits.length || copy.benefits.some(value => !value.trim())) issues.push(`${plan.key}/${site}/${locale}: name, summary, eligibility and benefits required`)
      if (copy.documents.some(link => !link.label.trim())) issues.push(`${plan.key}/${site}/${locale}: document labels required`);
      if (plan.sites.includes(site) && !groups.has(plan.group)) issues.push(`${plan.key}/${site}/${locale}: unknown display group`)
      if (plan.application.reviewPipeline) issues.push(`${plan.key}: review pipelines are not supported by the published website application; use an enquiry`);
      if (plan.application.type === 'application' && plan.billingPeriod === 'manual' && plan.availability === 'public') issues.push(`${plan.key}: manual plans require an enquiry`)
    }
  }
  return [...new Set(issues)]
}

export function resolveMembershipCatalogue(document: MembershipCatalogueDocument, site: MembershipSite, includeHidden = false) {
  return { page: document.pages[site], plans: document.plans.filter(plan => includeHidden || plan.sites.includes(site))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)).map(plan => ({
      ...plan, i18n: {en:{...plan.i18n.en,...plan.overrides[site]?.en},"zh-Hant":{...plan.i18n["zh-Hant"],...plan.overrides[site]?.["zh-Hant"]},"zh-Hans":{...plan.i18n["zh-Hans"],...plan.overrides[site]?.["zh-Hans"]}}, overrides: undefined,
    })) }
}
