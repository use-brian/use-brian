import { z } from 'zod'

export const MAX_DRAWING_BYTES = 2 * 1024 * 1024
export const MAX_DRAWING_PREVIEW_BYTES = 1024 * 1024
export const MAX_DRAWING_PREVIEW_DIMENSION = 1600

const presenceCoordinate = z.number().finite().min(-10_000_000).max(10_000_000)
export const drawingPresenceSchema = z.object({
  scope: z.string().min(1).max(512),
  pointer: z.object({ x: presenceCoordinate, y: presenceCoordinate, tool: z.literal('pointer') }).nullable(),
  button: z.enum(['up', 'down']),
  selected: z.array(z.string().min(1).max(128)).max(256),
})
export const drawingPresenceUserSchema = z.object({
  name: z.string().min(1).max(200), color: z.string().regex(/^#[0-9a-f]{6}$/i),
})
export type DrawingPresence = z.infer<typeof drawingPresenceSchema>

export const drawingLibraryPreviewPathSchema = z.string().max(1024)
  .regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:png|jpe?g|webp|svg)$/)

export const drawingLibraryIndexSchema = z.array(z.object({
  name: z.string().trim().min(1).max(200),
  authors: z.array(z.object({ name: z.string().trim().min(1).max(200) })).max(20),
  source: z.string().max(1024).regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.excalidrawlib$/),
  preview: drawingLibraryPreviewPathSchema.optional().catch(undefined),
})).min(1).max(2000)

export const drawingLibraryMessageSchema = z.object({
  type: z.literal('brian:drawing-library'),
  token: z.string().regex(/^[a-f0-9]{32}$/),
  url: z.string().max(2048),
}).strict()

// Portable envelope checks only. Core must fully decode before model delivery.
export const drawingPreviewSchema = z.object({
  mimeType: z.literal('image/png'),
  data: z.string().max(4 * Math.ceil(MAX_DRAWING_PREVIEW_BYTES / 3)).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  width: z.number().int().min(1).max(MAX_DRAWING_PREVIEW_DIMENSION),
  height: z.number().int().min(1).max(MAX_DRAWING_PREVIEW_DIMENSION),
  sceneDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((preview, ctx) => {
  if (preview.data.length > 4 * Math.ceil(MAX_DRAWING_PREVIEW_BYTES / 3)) return
  let bytes: string
  try { bytes = atob(preview.data) } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid drawing PNG base64' })
    return
  }
  const uint32 = (at: number) => [...bytes.slice(at, at + 4)].reduce((n, c) => n * 256 + c.charCodeAt(0), 0)
  if (bytes.length > MAX_DRAWING_PREVIEW_BYTES || bytes.length < 57 ||
    bytes.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || uint32(8) !== 13 || bytes.slice(12, 16) !== 'IHDR' ||
    uint32(16) !== preview.width || uint32(20) !== preview.height ||
    bytes.slice(-12) !== '\x00\x00\x00\x00IEND\xae\x42\x60\x82' || btoa(bytes) !== preview.data) {
    ctx.addIssue({ code: 'custom', message: 'Invalid drawing PNG export or dimensions' })
  }
})
export type DrawingPreview = z.infer<typeof drawingPreviewSchema>

export async function drawingSceneDigest(scene: DrawingScene): Promise<string> {
  // JSONB may reorder object keys. Hash canonical parsed data, not storage order.
  const json = JSON.stringify(drawingSceneSchema.parse(scene), (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

// Preserve versioned element fields; refuse executable embeds and remote files.
const pointSchema = z.tuple([z.number().finite(), z.number().finite()])
const bindingSchema = z.object({
  elementId: z.string(), focus: z.number().finite(), gap: z.number().finite(),
  fixedPoint: pointSchema.optional(),
}).passthrough().nullable().optional()
const elementBaseSchema = z.object({
  id: z.string().min(1),
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite(), height: z.number().finite(),
  isDeleted: z.boolean().optional(),
  fileId: z.string().nullable().optional(),
  link: z.null().optional(),
  groupIds: z.array(z.string()).optional(),
  boundElementIds: z.array(z.string()).nullable().optional(),
  boundElements: z.array(z.object({ id: z.string(), type: z.enum(['arrow', 'text']) }).passthrough()).nullable().optional(),
}).passthrough()

const linearSchema = elementBaseSchema.extend({
  points: z.array(pointSchema).min(2),
  startBinding: bindingSchema, endBinding: bindingSchema,
})

// restoreElements checks points before applying defaults. Freehand pressure
// data and text/font metrics are also consumed without usable defaults in 0.18.
const elementSchema = z.discriminatedUnion('type', [
  elementBaseSchema.extend({ type: z.literal('rectangle') }),
  elementBaseSchema.extend({ type: z.literal('diamond') }),
  elementBaseSchema.extend({ type: z.literal('ellipse') }),
  elementBaseSchema.extend({ type: z.literal('frame'), name: z.string().nullable().optional() }),
  linearSchema.extend({ type: z.literal('line') }),
  linearSchema.extend({
    type: z.literal('arrow'), elbowed: z.boolean().optional(),
    fixedSegments: z.array(z.object({ start: pointSchema, end: pointSchema, index: z.number().int().nonnegative() }).passthrough()).nullable().optional(),
  }),
  elementBaseSchema.extend({
    type: z.literal('freedraw'), points: z.array(pointSchema).min(1),
    simulatePressure: z.boolean(), pressures: z.array(z.number().finite().min(0).max(1)),
  }),
  elementBaseSchema.extend({
    type: z.literal('text'), text: z.string(), fontSize: z.number().finite().positive(),
    fontFamily: z.number().int().positive(), lineHeight: z.number().finite().positive().optional(),
    // Legacy `font` overrides the numeric metrics during restoration.
    font: z.never().optional(), originalText: z.string().optional(),
  }),
  elementBaseSchema.extend({
    type: z.literal('image'), scale: pointSchema.optional(),
    crop: z.object({
      x: z.number().finite(), y: z.number().finite(),
      width: z.number().finite().positive(), height: z.number().finite().positive(),
      naturalWidth: z.number().finite().positive(), naturalHeight: z.number().finite().positive(),
    }).passthrough().nullable().optional(),
  }),
]).superRefine((element, ctx) => {
  if (element.type === 'freedraw' && !element.simulatePressure && element.pressures.length !== element.points.length) {
    ctx.addIssue({ code: 'custom', path: ['pressures'], message: 'Freehand pressure samples must match points' })
  }
})

export const drawingSceneSchema = z.object({
  version: z.literal(1),
  elements: z.array(elementSchema).max(5000),
  appState: z.object({ viewBackgroundColor: z.string().max(64) }).strict(),
  files: z.record(z.object({
    id: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    dataURL: z.string().regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/),
    created: z.number().finite(),
    lastRetrieved: z.number().finite().optional(),
    version: z.number().finite().optional(),
  }).strict()),
}).strict().superRefine((scene, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(scene)).length > MAX_DRAWING_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'Drawing exceeds 2 MiB' })
  }
  for (const element of scene.elements) {
    if (element.type === 'image' && !element.isDeleted &&
      (!element.fileId || !scene.files[element.fileId])) {
      ctx.addIssue({ code: 'custom', message: 'Drawing image file is missing' })
    }
  }
  for (const [id, file] of Object.entries(scene.files)) {
    if (file.id !== id || !file.dataURL.startsWith(`data:${file.mimeType};base64,`)) {
      ctx.addIssue({ code: 'custom', message: 'Drawing image metadata mismatch' })
    }
  }
})

export const drawingTitleSchema = z.string().trim().max(200).optional()

/** Restore/repair a concurrent union without accepting malformed geometry/assets. */
export function parseDrawingSceneStructure(value: unknown): DrawingScene {
  const parsed = drawingSceneSchema.safeParse(value)
  if (parsed.success) return parsed.data
  if (parsed.error.issues.every(issue =>
    (issue.code === 'too_big' && issue.path.join('.') === 'elements') ||
    (issue.code === 'custom' && issue.message === 'Drawing exceeds 2 MiB'))) return value as DrawingScene
  throw parsed.error
}

export const drawingBlockSchema = z.object({
  kind: z.literal('drawing'),
  title: drawingTitleSchema,
  id: z.string().min(1).max(128),
  scene: drawingSceneSchema,
  preview: drawingPreviewSchema.optional(),
  collaborationError: z.literal('invalid-registers').optional(),
})
export type DrawingScene = z.infer<typeof drawingSceneSchema>
export type DrawingBlock = z.infer<typeof drawingBlockSchema>

export { defaultDrawingLibrary } from './drawing-default-library.js'
export { parseLibrary, validateLibraryItems, type DrawingLibraryItem } from './drawing-library.js'
export * from './drawing-actions.js'
