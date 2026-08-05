/** Office template registry endpoints. [COMP:api/office-routes] */
import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'

type TemplateDraftRow = {
  id: string
  workspaceId: string
  family: 'document' | 'presentation'
  name: string
  lifecycleState: 'draft' | 'admitted' | 'deprecated' | 'trash' | 'retained'
  draftArtifactId: string | null
}

type TemplateLiveSnapshot = { snapshot: OfficeArtifactSnapshot; seq: number; baseVersion: number }

export type OfficeTemplatesRouteDeps = {
  list(userId: string, workspaceId: string, family?: 'document' | 'presentation'): Promise<unknown[]>
  getTemplate(userId: string, templateId: string): Promise<TemplateDraftRow | null>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<TemplateLiveSnapshot | null>
  createDraft(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential'; draftArtifactId: string }): Promise<{ id: string }>
  createTemplateShell(params: { userId: string; workspaceId: string; family: 'document' | 'presentation'; title: string; templateVersionId: null; capabilityVersion: number; sensitivity: 'public' | 'internal' | 'confidential'; mode: 'template' }): Promise<{ id: string }>
  initializeDraft(params: { userId: string; artifactId: string; snapshot: OfficeArtifactSnapshot }): Promise<boolean>
  deleteEmptyDraft(userId: string, templateId: string): Promise<boolean>
  deleteEmptyShell(userId: string, artifactId: string): Promise<boolean>
  createCompileJob(params: { userId: string; workspaceId: string; artifactId: string; assistantId: string | null; jobKind: 'template_compile'; brief: unknown; authorityProjection: unknown; idempotencyKey: string }): Promise<{ id: string }>
  wakeCompile?(userId: string): void
  transitionLifecycle(params: { userId: string; templateId: string; action: 'deprecate' | 'restore' | 'trash' | 'purge'; reason: string }): Promise<unknown | null>
}

export function officeTemplateRoutes(deps: OfficeTemplatesRouteDeps): Router {
  const router = Router()
  router.get('/templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const workspaceId = z.string().uuid().safeParse(req.query.workspaceId)
    const family = z.enum(['document', 'presentation']).optional().safeParse(req.query.family)
    if (!workspaceId.success || !family.success) return void res.status(400).json({ error: 'Invalid template query' })
    res.json({ templates: await deps.list(userId, workspaceId.data, family.data) })
  })
  router.post('/templates', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ workspaceId: z.string().uuid(), family: z.enum(['document', 'presentation']), name: z.string().min(1).max(255), description: z.string().min(1).max(4_000), creationMethod: z.enum(['guided', 'upload']).default('guided'), sensitivity: z.enum(['public', 'internal', 'confidential']).default('internal') }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template draft', issues: body.error.issues })
    let artifact: { id: string } | null = null
    let template: { id: string } | null = null
    try {
      artifact = await deps.createTemplateShell({ userId, workspaceId: body.data.workspaceId, family: body.data.family, title: body.data.name, templateVersionId: null, capabilityVersion: 1, sensitivity: body.data.sensitivity, mode: 'template' })
      const { creationMethod, ...draft } = body.data
      template = await deps.createDraft({ userId, ...draft, draftArtifactId: artifact.id })
      await deps.initializeDraft({
        userId,
        artifactId: artifact.id,
        snapshot: creationMethod === 'guided'
          ? guidedTemplateSnapshot({ artifactId: artifact.id, workspaceId: body.data.workspaceId, family: body.data.family, title: body.data.name, guidance: body.data.description })
          : blankTemplateSnapshot({ artifactId: artifact.id, workspaceId: body.data.workspaceId, family: body.data.family, title: body.data.name }),
      })
    } catch (cause) {
      await Promise.allSettled([
        template ? deps.deleteEmptyDraft(userId, template.id) : Promise.resolve(false),
        artifact ? deps.deleteEmptyShell(userId, artifact.id) : Promise.resolve(false),
      ])
      throw cause
    }
    res.status(201).json({ ...template, draftArtifactId: artifact.id })
  })
  router.post('/templates/:templateId/draft/initialize', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ workspaceId: z.string().uuid(), draftArtifactId: z.string().uuid() }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template draft initialization', issues: body.error.issues })
    const templateId = String(req.params.templateId)
    const [template, artifact, current] = await Promise.all([
      deps.getTemplate(userId, templateId),
      deps.getArtifact(userId, body.data.draftArtifactId),
      deps.getSnapshot(userId, body.data.draftArtifactId),
    ])
    if (!template || !artifact || template.draftArtifactId !== artifact.id || template.workspaceId !== body.data.workspaceId || artifact.workspaceId !== body.data.workspaceId || template.family !== artifact.family || artifact.mode !== 'template') return void res.status(404).json({ error: 'Template draft not found' })
    if (current) return void res.json(current)
    if (template.lifecycleState !== 'draft' || artifact.lifecycleState !== 'active' || Number(artifact.headVersion) !== 0 || artifact.headVersionId !== null) return void res.status(409).json({ error: 'template_draft_not_initializable' })
    const created = await deps.initializeDraft({ userId, artifactId: artifact.id, snapshot: blankTemplateSnapshot({ artifactId: artifact.id, workspaceId: artifact.workspaceId, family: artifact.family, title: artifact.title }) })
    const live = await deps.getSnapshot(userId, artifact.id)
    if (!live) return void res.status(409).json({ error: 'template_draft_not_ready' })
    res.status(created ? 201 : 200).json(live)
  })
  router.post('/templates/:templateId/compile', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const source = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('upload'), fileId: z.string().uuid() }).strict(),
      z.object({ kind: z.literal('scratch') }).strict(),
      z.object({ kind: z.literal('promote'), artifactVersionId: z.string().uuid() }).strict(),
    ])
    const body = z.object({ workspaceId: z.string().uuid(), draftArtifactId: z.string().uuid(), assistantId: z.string().uuid().nullable().default(null), source, idempotencyKey: z.string().min(8).max(255) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template compile request', issues: body.error.issues })
    const job = await deps.createCompileJob({ userId, workspaceId: body.data.workspaceId, artifactId: body.data.draftArtifactId, assistantId: body.data.assistantId, jobKind: 'template_compile', brief: { templateId: String(req.params.templateId), source: body.data.source }, authorityProjection: { sensitivity: 'internal' }, idempotencyKey: body.data.idempotencyKey })
    deps.wakeCompile?.(userId)
    res.status(202).json({ jobId: job.id })
  })
  router.post('/templates/:templateId/lifecycle', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ action: z.enum(['deprecate', 'restore', 'trash', 'purge']), reason: z.string().min(1).max(2_000) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid template lifecycle request', issues: body.error.issues })
    const template = await deps.transitionLifecycle({ userId, templateId: String(req.params.templateId), ...body.data })
    if (!template) return void res.status(409).json({ error: 'template_lifecycle_blocked' })
    res.json({ template })
  })
  return router
}

export function blankTemplateSnapshot(params: { artifactId: string; workspaceId: string; family: 'document' | 'presentation'; title: string }): OfficeArtifactSnapshot {
  const common = {
    schemaVersion: 1 as const,
    capabilityVersion: 1 as const,
    artifactId: params.artifactId,
    workspaceId: params.workspaceId,
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: null,
    rootId: randomUUID(),
    title: params.title,
    resources: [],
    accessibility: { title: params.title },
  }
  if (params.family === 'document') {
    return {
      ...common,
      family: 'document',
      sections: [{
        id: randomUUID(),
        page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' },
        header: [],
        footer: [],
        showPageNumber: true,
        nodes: [],
      }],
    }
  }
  const masterId = randomUUID()
  const layoutId = randomUUID()
  return {
    ...common,
    family: 'presentation',
    slideSize: { widthPt: 960, heightPt: 540 },
    themeId: randomUUID(),
    masters: [{ id: masterId, name: 'Master', lockedObjectIds: [] }],
    layouts: [{ id: layoutId, masterId, name: 'Blank', placeholderIds: [] }],
    slides: [{ id: randomUUID(), title: 'Slide 1', masterId, layoutId, objects: [], readingOrder: [], notes: [] }],
  }
}

const templateTextStyle = (fontSizePt: number, bold = false) => ({
  fontFamily: 'Arial',
  fontSizePt,
  bold,
  italic: false,
  underline: false,
  strike: false,
  color: '#202124',
})

/** Seeds a useful, editable template draft from the member's guidance.
 * Artifact generation still requires the resulting draft to pass normal
 * template compilation and publish as an admitted immutable version. */
export function guidedTemplateSnapshot(params: { artifactId: string; workspaceId: string; family: 'document' | 'presentation'; title: string; guidance: string }): OfficeArtifactSnapshot {
  const base = blankTemplateSnapshot(params)
  const guidance = params.guidance.trim().replace(/\s+/g, ' ').slice(0, 480)
  if (base.family === 'document') {
    return {
      ...base,
      sections: base.sections.map((section, index) => index === 0 ? {
        ...section,
        nodes: [
          { id: randomUUID(), kind: 'heading', level: 1, styleName: 'Heading 1', runs: [{ id: randomUUID(), text: params.title, style: templateTextStyle(28, true) }] },
          { id: randomUUID(), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: randomUUID(), text: guidance, style: templateTextStyle(11) }] },
          { id: randomUUID(), kind: 'heading', level: 2, styleName: 'Heading 2', runs: [{ id: randomUUID(), text: 'Section heading', style: templateTextStyle(18, true) }] },
          { id: randomUUID(), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: randomUUID(), text: 'Replace this text with content for the artifact.', style: templateTextStyle(11) }] },
        ],
      } : section),
    }
  }
  const masterId = base.masters[0].id
  const layoutId = base.layouts[0].id
  const titleId = randomUUID()
  const subtitleId = randomUUID()
  const contentTitleId = randomUUID()
  const contentBodyId = randomUUID()
  return {
    ...base,
    layouts: [{ ...base.layouts[0], name: 'General', placeholderIds: [] }],
    slides: [{
      id: randomUUID(), title: 'Title', masterId, layoutId, notes: [],
      objects: [
        { id: titleId, kind: 'text', geometry: { xPt: 72, yPt: 150, widthPt: 816, heightPt: 72, rotationDeg: 0 }, locked: false, alignment: 'center', verticalAlignment: 'middle', runs: [{ id: randomUUID(), text: params.title, style: templateTextStyle(34, true) }] },
        { id: subtitleId, kind: 'text', geometry: { xPt: 144, yPt: 240, widthPt: 672, heightPt: 90, rotationDeg: 0 }, locked: false, alignment: 'center', verticalAlignment: 'top', runs: [{ id: randomUUID(), text: guidance, style: templateTextStyle(16) }] },
      ],
      readingOrder: [titleId, subtitleId],
    }, {
      id: randomUUID(), title: 'Content', masterId, layoutId, notes: [],
      objects: [
        { id: contentTitleId, kind: 'text', geometry: { xPt: 60, yPt: 42, widthPt: 840, heightPt: 54, rotationDeg: 0 }, locked: false, alignment: 'start', verticalAlignment: 'middle', runs: [{ id: randomUUID(), text: 'Section title', style: templateTextStyle(26, true) }] },
        { id: contentBodyId, kind: 'text', geometry: { xPt: 72, yPt: 132, widthPt: 816, heightPt: 300, rotationDeg: 0 }, locked: false, alignment: 'start', verticalAlignment: 'top', runs: [{ id: randomUUID(), text: 'Replace this text with the main ideas, evidence, and visuals for the artifact.', style: templateTextStyle(18) }] },
      ],
      readingOrder: [contentTitleId, contentBodyId],
    }],
  }
}
