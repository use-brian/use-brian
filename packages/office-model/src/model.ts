import { z } from 'zod'

/** Canonical Office model. See docs/architecture/features/office.md. */
export const OFFICE_SCHEMA_VERSION = 1 as const
export const OFFICE_CAPABILITY_VERSION = 1 as const

export const OfficeUuidSchema = z.string().uuid()
export const OfficeFamilySchema = z.enum(['document', 'presentation'])
export type OfficeFamily = z.infer<typeof OfficeFamilySchema>

export const OfficeSensitivitySchema = z.enum(['public', 'internal', 'confidential'])
export type OfficeSensitivity = z.infer<typeof OfficeSensitivitySchema>

export const OfficeResourceRefSchema = z
  .object({
    id: OfficeUuidSchema,
    kind: z.enum(['font', 'theme', 'image', 'video', 'template-fragment']),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.string().min(1).max(255),
    sensitivity: OfficeSensitivitySchema,
  })
  .strict()
export type OfficeResourceRef = z.infer<typeof OfficeResourceRefSchema>

export const OfficeColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/)

export const OfficeTextStyleSchema = z
  .object({
    fontFamily: z.string().min(1).max(128),
    fontSizePt: z.number().min(8).max(144),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    underline: z.boolean().default(false),
    strike: z.boolean().default(false),
    color: OfficeColorSchema,
    highlight: OfficeColorSchema.optional(),
    language: z.string().min(2).max(35).optional(),
  })
  .strict()

export const OfficeRichTextRunSchema = z
  .object({
    id: OfficeUuidSchema,
    text: z.string().max(100_000),
    style: OfficeTextStyleSchema,
    href: z.string().url().refine((url) => /^(https:|mailto:)/.test(url), {
      message: 'Only inert HTTPS and mailto links are supported',
    }).optional(),
  })
  .strict()
export type OfficeRichTextRun = z.infer<typeof OfficeRichTextRunSchema>

const NodeBaseSchema = z.object({ id: OfficeUuidSchema })

export const OfficeParagraphSchema = NodeBaseSchema.extend({
  kind: z.literal('paragraph'),
  runs: z.array(OfficeRichTextRunSchema).max(10_000),
  styleName: z.string().min(1).max(128).default('Body'),
  alignment: z.enum(['start', 'center', 'end', 'justify']).default('start'),
}).strict()

export const OfficeHeadingSchema = NodeBaseSchema.extend({
  kind: z.literal('heading'),
  level: z.number().int().min(1).max(6),
  runs: z.array(OfficeRichTextRunSchema).max(1_000),
  styleName: z.string().min(1).max(128),
}).strict()

export const OfficeListSchema = NodeBaseSchema.extend({
  kind: z.literal('list'),
  ordered: z.boolean(),
  level: z.number().int().min(0).max(8),
  items: z.array(z.object({ id: OfficeUuidSchema, runs: z.array(OfficeRichTextRunSchema) }).strict()).max(1_000),
}).strict()

export const OfficeTableSchema = NodeBaseSchema.extend({
  kind: z.literal('table'),
  headerRows: z.number().int().min(1).max(10),
  rows: z.array(
    z.object({
      id: OfficeUuidSchema,
      cells: z.array(
        z.object({
          id: OfficeUuidSchema,
          runs: z.array(OfficeRichTextRunSchema),
          rowSpan: z.number().int().min(1).max(100).default(1),
          colSpan: z.number().int().min(1).max(100).default(1),
        }).strict(),
      ).min(1).max(100),
    }).strict(),
  ).min(1).max(5_000),
}).strict()

export const OfficeImageSchema = NodeBaseSchema.extend({
  kind: z.literal('image'),
  resourceId: OfficeUuidSchema,
  altText: z.string().max(2_000),
  decorative: z.boolean(),
  widthPt: z.number().positive().max(10_000),
  heightPt: z.number().positive().max(10_000),
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict().optional(),
}).strict()

export const OfficeChartSchema = NodeBaseSchema.extend({
  kind: z.literal('chart'),
  chartType: z.enum(['bar', 'line', 'pie', 'doughnut']),
  title: z.string().min(1).max(500),
  categories: z.array(z.string().max(500)).min(1).max(500),
  series: z.array(z.object({ name: z.string().min(1).max(200), values: z.array(z.number()).max(500) }).strict()).min(1).max(50),
  altText: z.string().min(1).max(2_000),
}).strict()

const OfficeVideoBaseSchema = NodeBaseSchema.extend({
  kind: z.literal('video'),
  resourceId: OfficeUuidSchema,
  posterResourceId: OfficeUuidSchema,
  altText: z.string().min(1).max(2_000),
  captionsResourceId: OfficeUuidSchema.optional(),
  transcript: z.string().min(1).max(200_000).optional(),
  recipientAccessibleUrl: z.string().url().refine((url) => url.startsWith('https:'), {
    message: 'DOCX video links must use HTTPS',
  }).optional(),
}).strict()

export const OfficeVideoSchema = OfficeVideoBaseSchema.refine((value) => Boolean(value.captionsResourceId || value.transcript), {
  message: 'Video requires captions or a transcript',
})

export const OfficePageBreakSchema = NodeBaseSchema.extend({ kind: z.literal('pageBreak') }).strict()
export const OfficeSectionBreakSchema = NodeBaseSchema.extend({ kind: z.literal('sectionBreak') }).strict()

export const DocumentFlowNodeSchema = z.union([
  OfficeParagraphSchema,
  OfficeHeadingSchema,
  OfficeListSchema,
  OfficeTableSchema,
  OfficeImageSchema,
  OfficeChartSchema,
  OfficeVideoSchema,
  OfficePageBreakSchema,
  OfficeSectionBreakSchema,
])
export type DocumentFlowNode = z.infer<typeof DocumentFlowNodeSchema>

export const DocumentSectionSchema = z
  .object({
    id: OfficeUuidSchema,
    page: z.object({ widthPt: z.number().min(144).max(2_000), heightPt: z.number().min(144).max(2_000), marginTopPt: z.number().min(0).max(500), marginRightPt: z.number().min(0).max(500), marginBottomPt: z.number().min(0).max(500), marginLeftPt: z.number().min(0).max(500), orientation: z.enum(['portrait', 'landscape']) }).strict(),
    header: z.array(OfficeRichTextRunSchema).max(1_000),
    footer: z.array(OfficeRichTextRunSchema).max(1_000),
    showPageNumber: z.boolean(),
    nodes: z.array(DocumentFlowNodeSchema).max(50_000),
  })
  .strict()

export const OfficeGeometrySchema = z
  .object({
    xPt: z.number().min(-10_000).max(10_000),
    yPt: z.number().min(-10_000).max(10_000),
    widthPt: z.number().positive().max(10_000),
    heightPt: z.number().positive().max(10_000),
    rotationDeg: z.number().min(-360).max(360).default(0),
  })
  .strict()

const SlideObjectBaseSchema = NodeBaseSchema.extend({
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
})

export const PresentationTextSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('text'),
  runs: z.array(OfficeRichTextRunSchema).max(10_000),
  alignment: z.enum(['start', 'center', 'end', 'justify']).default('start'),
  verticalAlignment: z.enum(['top', 'middle', 'bottom']).default('top'),
}).strict()

export const PresentationImageSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('image'),
  resourceId: OfficeUuidSchema,
  altText: z.string().max(2_000),
  decorative: z.boolean(),
}).strict()

export const PresentationShapeSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('shape'),
  shape: z.enum(['rectangle', 'roundedRectangle', 'ellipse', 'triangle', 'line']),
  fill: OfficeColorSchema.optional(),
  stroke: OfficeColorSchema.optional(),
  strokeWidthPt: z.number().min(0).max(100).default(1),
  text: z.array(OfficeRichTextRunSchema).max(1_000).default([]),
  altText: z.string().max(2_000).optional(),
}).strict()

export const PresentationConnectorSchema = SlideObjectBaseSchema.extend({
  kind: z.literal('connector'),
  connector: z.enum(['straight', 'elbow']),
  fromObjectId: OfficeUuidSchema.optional(),
  toObjectId: OfficeUuidSchema.optional(),
  stroke: OfficeColorSchema,
}).strict()

export const PresentationTableSchema = OfficeTableSchema.omit({ kind: true }).extend({
  kind: z.literal('table'),
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
}).strict()

export const PresentationChartSchema = OfficeChartSchema.omit({ kind: true }).extend({
  kind: z.literal('chart'),
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
}).strict()

export const PresentationVideoSchema = OfficeVideoBaseSchema.extend({
  geometry: OfficeGeometrySchema,
  locked: z.boolean().default(false),
}).strict().refine((value) => Boolean(value.captionsResourceId || value.transcript), {
  message: 'Video requires captions or a transcript',
})

export const PresentationObjectSchema = z.union([
  PresentationTextSchema,
  PresentationImageSchema,
  PresentationShapeSchema,
  PresentationConnectorSchema,
  PresentationTableSchema,
  PresentationChartSchema,
  PresentationVideoSchema,
])
export type PresentationObject = z.infer<typeof PresentationObjectSchema>

export const PresentationSlideSchema = z
  .object({
    id: OfficeUuidSchema,
    title: z.string().min(1).max(500),
    masterId: OfficeUuidSchema,
    layoutId: OfficeUuidSchema,
    objects: z.array(PresentationObjectSchema).max(10_000),
    readingOrder: z.array(OfficeUuidSchema).max(10_000),
    notes: z.array(OfficeRichTextRunSchema).max(10_000),
  })
  .strict()
  .superRefine((slide, ctx) => {
    const ids = new Set(slide.objects.map((object) => object.id))
    if (slide.readingOrder.length !== ids.size || slide.readingOrder.some((id) => !ids.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readingOrder'], message: 'Reading order must contain every slide object exactly once' })
    }
  })

const ArtifactCommonSchema = z.object({
  schemaVersion: z.literal(OFFICE_SCHEMA_VERSION),
  capabilityVersion: z.literal(OFFICE_CAPABILITY_VERSION),
  artifactId: OfficeUuidSchema,
  workspaceId: OfficeUuidSchema,
  locale: z.string().min(2).max(35),
  defaultLanguage: z.string().min(2).max(35),
  templateVersionId: OfficeUuidSchema,
  rootId: OfficeUuidSchema,
  title: z.string().min(1).max(1_000),
  resources: z.array(OfficeResourceRefSchema).max(20_000),
  accessibility: z.object({ title: z.string().min(1).max(1_000), description: z.string().max(4_000).optional() }).strict(),
})

export const DocumentSnapshotSchema = ArtifactCommonSchema.extend({
  family: z.literal('document'),
  sections: z.array(DocumentSectionSchema).min(1).max(10_000),
}).strict()
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>

export const PresentationSnapshotSchema = ArtifactCommonSchema.extend({
  family: z.literal('presentation'),
  slideSize: z.object({ widthPt: z.number().min(144).max(2_000), heightPt: z.number().min(144).max(2_000) }).strict(),
  themeId: OfficeUuidSchema,
  masters: z.array(z.object({ id: OfficeUuidSchema, name: z.string().min(1), lockedObjectIds: z.array(OfficeUuidSchema) }).strict()).min(1),
  layouts: z.array(z.object({ id: OfficeUuidSchema, masterId: OfficeUuidSchema, name: z.string().min(1), placeholderIds: z.array(OfficeUuidSchema) }).strict()).min(1),
  slides: z.array(PresentationSlideSchema).min(1).max(1_000),
}).strict()
export type PresentationSnapshot = z.infer<typeof PresentationSnapshotSchema>

export const OfficeArtifactSnapshotSchema = z.discriminatedUnion('family', [
  DocumentSnapshotSchema,
  PresentationSnapshotSchema,
])
export type OfficeArtifactSnapshot = z.infer<typeof OfficeArtifactSnapshotSchema>

export function assertOfficeArtifactSnapshot(value: unknown): OfficeArtifactSnapshot {
  return OfficeArtifactSnapshotSchema.parse(value)
}
