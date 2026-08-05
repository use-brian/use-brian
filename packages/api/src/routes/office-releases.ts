/** Exact-head review/release and separately reviewed derivative routes.
 * [COMP:api/office-routes] */
import { Router } from 'express'
import { z } from 'zod'
import { prepareOfficeRelease, reviewOfficeRelease, type OfficeReleaseAcknowledgement, type OfficeReleaseAction, type OfficeReleaseDestination } from '../office/release.js'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import type { ResolvedOfficeAccess } from '../office/access.js'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { OfficeResourceResolver } from '@use-brian/core'

type Context = {
  artifact: OfficeArtifactRow
  access: ResolvedOfficeAccess
  snapshot: OfficeArtifactSnapshot
  claims: Array<{ id: string; classification: string; confidence: number; severity: string; reasonCode: string; status: string }>
  media: Array<{ id: string; provenanceState: string; disclosureRequired: boolean }>
}

export type OfficeReleaseRouteDeps = {
  load(userId: string, artifactId: string): Promise<Context | null>
  resolveResource(userId: string, workspaceId: string): OfficeResourceResolver
  saveReleasedFile(params: { userId: string; workspaceId: string; artifactId: string; version: number; action: OfficeReleaseAction; extension: 'docx' | 'pptx'; mime: string; bytes: Uint8Array }): Promise<string>
  createRecord(params: { userId: string; artifactId: string; versionId: string; workspaceId: string; action: OfficeReleaseAction; destination: OfficeReleaseDestination; receipt: ReturnType<typeof reviewOfficeRelease>; acknowledgement?: OfficeReleaseAcknowledgement; releasedFileId: string }): Promise<{ id: string }>
  createDerivative(params: { userId: string; source: Context; title: string; sensitivity: 'public' | 'internal' | 'confidential'; selectedObjectIds: string[]; visibilityUserIds: string[] }): Promise<{ artifactId: string; version: number }>
}

const Action = z.enum(['export', 'share', 'present', 'send', 'publish'])
const Destination = z.object({ sensitivity: z.enum(['public', 'internal', 'confidential']), external: z.boolean(), disclosureSatisfied: z.boolean().optional() }).strict()
const Acknowledgement = z.object({ version: z.number().int().min(0), action: Action, codes: z.array(z.string().min(1)).max(10_000) }).strict()
const Review = z.object({ expectedVersion: z.number().int().min(0), action: Action, destination: Destination, acknowledgement: Acknowledgement.optional() }).strict()

export function officeReleaseRoutes(deps: OfficeReleaseRouteDeps): Router {
  const router = Router()
  const load = async (userId: string, artifactId: string) => deps.load(userId, artifactId)
  router.post('/artifacts/:artifactId/releases/preflight', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = Review.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office release review', issues: body.error.issues })
    const context = await load(userId, String(req.params.artifactId))
    if (!context) return void res.status(404).json({ error: 'Office artifact not found' })
    const receipt = reviewOfficeRelease({ snapshot: context.snapshot, expectedVersion: body.data.expectedVersion, currentVersion: context.artifact.headVersion, headVersionId: context.artifact.headVersionId, lifecycleState: context.artifact.lifecycleState, canEdit: context.access.canEdit, artifactSensitivity: context.artifact.sensitivity, action: body.data.action, destination: body.data.destination, claims: context.claims, media: context.media, acknowledgement: body.data.acknowledgement })
    res.json({ receipt })
  })
  router.post('/artifacts/:artifactId/releases', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = Review.safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office release request', issues: body.error.issues })
    const artifactId = String(req.params.artifactId)
    const context = await load(userId, artifactId)
    if (!context) return void res.status(404).json({ error: 'Office artifact not found' })
    const prepared = await prepareOfficeRelease({ snapshot: context.snapshot, expectedVersion: body.data.expectedVersion, currentVersion: context.artifact.headVersion, headVersionId: context.artifact.headVersionId, lifecycleState: context.artifact.lifecycleState, canEdit: context.access.canEdit, artifactSensitivity: context.artifact.sensitivity, action: body.data.action, destination: body.data.destination, claims: context.claims, media: context.media, acknowledgement: body.data.acknowledgement, resolveResource: deps.resolveResource(userId, context.artifact.workspaceId) })
    if (prepared.receipt.status !== 'ready' || !prepared.bytes || !prepared.extension || !prepared.mime) return void res.status(409).json({ receipt: prepared.receipt })
    const releasedFileId = await deps.saveReleasedFile({ userId, workspaceId: context.artifact.workspaceId, artifactId, version: context.artifact.headVersion, action: body.data.action, extension: prepared.extension, mime: prepared.mime, bytes: prepared.bytes })
    const record = await deps.createRecord({ userId, artifactId, versionId: context.artifact.headVersionId!, workspaceId: context.artifact.workspaceId, action: body.data.action, destination: body.data.destination, receipt: prepared.receipt, acknowledgement: body.data.acknowledgement, releasedFileId })
    res.status(201).json({ releaseId: record.id, fileId: releasedFileId, receipt: prepared.receipt })
  })
  router.post('/artifacts/:artifactId/derivatives', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const body = z.object({ title: z.string().min(1).max(1_000), sensitivity: z.enum(['public', 'internal', 'confidential']), selectedObjectIds: z.array(z.string().uuid()).max(20_000).default([]), visibilityUserIds: z.array(z.string().uuid()).max(10_000).default([]) }).strict().safeParse(req.body)
    if (!body.success) return void res.status(400).json({ error: 'Invalid Office derivative request', issues: body.error.issues })
    const source = await load(userId, String(req.params.artifactId))
    if (!source || !source.access.canEdit || source.artifact.lifecycleState !== 'active') return void res.status(404).json({ error: 'Office artifact not found' })
    const lower = ({ public: 0, internal: 1, confidential: 2 } as const)[body.data.sensitivity] < ({ public: 0, internal: 1, confidential: 2 } as const)[source.artifact.sensitivity]
    if (lower && body.data.selectedObjectIds.length === 0) return void res.status(409).json({ error: 'filtered_selection_required' })
    res.status(201).json(await deps.createDerivative({ userId, source, ...body.data }))
  })
  return router
}
