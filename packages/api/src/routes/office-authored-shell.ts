/** Source-free human authoring only; generation/import/copy use other routes. */
import { Router } from 'express'
import { z } from 'zod'
import { officeArtifactStore } from '../db/office-artifacts.js'
import type { OfficeCreateOptions } from '../workspace-access/office-create-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

const ShellSchema = z.object({
  workspaceId: z.string().uuid(),
  family: z.enum(['document', 'presentation', 'spreadsheet']),
  title: z.string().trim().min(1).max(1_000),
  sensitivity: z.enum(['public', 'internal', 'confidential']).default('internal'),
  visibility: z.enum(['workspace', 'private']).default('workspace'),
  // Do not default these arrays: omission and explicit General are distinct.
  requiredCompartments: z.array(z.string().min(1).max(255)).max(100).optional(),
  projectIds: z.array(z.string().uuid()).max(100).optional(),
  destination: z.discriminatedUnion('kind', [z.object({kind:z.literal('department'),departmentId:z.string().uuid()}).strict(),z.object({kind:z.literal('general')}).strict()]).optional(),
  expectedPolicyRevision: z.string().regex(/^\d+$/).optional(),
}).strict()

/** Mounted beneath requireAuth by the existing Office router mount. A current
 * revocable human session is required, not merely a userId attributed by a key
 * or agent adapter. No source/content/template fields are accepted, and no job
 * is created. This proof is local to this call and never read from request JSON.
 */
export function officeAuthoredShellRoutes(): Router {
  const router = Router()
  router.post('/artifacts/shell', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!req.userId || !req.authSessionId || req.authVersion === undefined) {
      return void res.status(401).json({ error: 'authenticated_session_required' })
    }
    const parsed = ShellSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'invalid_office_shell_request' })
    const input = parsed.data
    const options: OfficeCreateOptions = {
      provenance: { kind: 'human_authored_root', actorUserId: req.userId, workspaceId: input.workspaceId },
      expectedPolicyRevision: input.expectedPolicyRevision,
      destination: input.destination,
    }
    try {
      const artifact = await officeArtifactStore.createShell({
        userId: req.userId, workspaceId: input.workspaceId, family: input.family,
        title: input.title, templateVersionId: null, capabilityVersion: 1,
        sensitivity: input.sensitivity,
        visibilityUserIds: input.visibility === 'private' ? [req.userId] : [],
        requiredCompartments: input.requiredCompartments, projectIds: input.projectIds,
      }, options)
      res.status(201).json({ artifact })
    } catch (cause) {
      if (cause instanceof WorkspaceAccessError) return void res.status(cause.status).json({ error: cause.code })
      throw cause
    }
  })
  return router
}
