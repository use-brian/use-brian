/**
 * Doc custom-themes routes (migration 226).
 *
 * Workspace-shared, AI-generated colour themes for the doc surface. A member
 * POSTs a prompt; the model produces a colour seed, the deterministic builder
 * expands it to tokens (`doc/theme-generator.ts`), and it's saved via the
 * store. The **invisible 5-per-workspace cap** lives in the store's atomic
 * INSERT and surfaces here as a 409.
 *
 *   GET    /workspaces/:workspaceId/doc-themes   → list (member only)
 *   POST   /workspaces/:workspaceId/doc-themes   → { prompt } → generate + save
 *   PATCH  /doc-themes/:id                        → { name }  → rename
 *   DELETE /doc-themes/:id                        → remove
 *
 * Membership is enforced two ways: `workspaceStore.getRole` on the workspace
 * routes, and RLS on every store call (a non-member's `getById` returns null →
 * 404). Reads/writes go through `queryWithRLS` inside the store.
 *
 * Spec: docs/architecture/features/doc-custom-themes.md.
 *
 * [COMP:doc-themes/route]
 */

import { Router } from 'express'
import { z } from 'zod'
import type { LLMProvider } from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  ThemeLimitReachedError,
  type DocThemeStore,
  type StoredDocTheme,
} from '../db/doc-themes-store.js'
import {
  generateCustomTheme,
  refineCustomTheme,
  ThemeGenerationError,
} from '../doc/theme-generator.js'

export type DocThemesRouteOptions = {
  docThemesStore: DocThemeStore
  workspaceStore: WorkspaceStore
  /** Optional — when unset, POST (the only model-using route) returns 503. */
  provider?: LLMProvider
}

const createSchema = z.object({ prompt: z.string().trim().min(1).max(600) })
const renameSchema = z.object({ name: z.string().trim().min(1).max(40) })
const refineSchema = z.object({ instruction: z.string().trim().min(1).max(600) })

function unauthorized(res: import('express').Response): void {
  res.status(401).json({ error: 'Unauthorized' })
}
function notMember(res: import('express').Response): void {
  res.status(403).json({ error: 'Not a member of this workspace' })
}
function notFound(res: import('express').Response): void {
  res.status(404).json({ error: 'Not found' })
}
function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: message })
}

function toWire(t: StoredDocTheme) {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    createdBy: t.createdBy,
    name: t.name,
    description: t.description,
    prompt: t.prompt,
    seed: t.seed,
    tokens: t.tokens,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }
}

export function docThemesRoutes(opts: DocThemesRouteOptions): Router {
  const router = Router()

  // GET /workspaces/:workspaceId/doc-themes
  router.get('/workspaces/:workspaceId/doc-themes', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)

    const themes = await opts.docThemesStore.list(userId, workspaceId)
    res.json({ themes: themes.map(toWire) })
  })

  // POST /workspaces/:workspaceId/doc-themes  { prompt }
  router.post('/workspaces/:workspaceId/doc-themes', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) return notMember(res)

    if (!opts.provider) {
      return res.status(503).json({ error: 'Theme generation is not available' })
    }

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join('; '))
    }

    let generated
    try {
      generated = await generateCustomTheme({ provider: opts.provider, prompt: parsed.data.prompt })
    } catch (err) {
      if (err instanceof ThemeGenerationError) {
        return res.status(422).json({ error: err.message })
      }
      throw err
    }

    try {
      const created = await opts.docThemesStore.create({
        userId,
        workspaceId,
        name: generated.name,
        description: generated.description,
        prompt: parsed.data.prompt,
        seed: generated.seed,
        tokens: generated.tokens,
      })
      res.status(201).json({ theme: toWire(created) })
    } catch (err) {
      if (err instanceof ThemeLimitReachedError) {
        // The invisible cap, surfaced. 409 so the client shows the
        // "delete one to create another" message.
        return res.status(409).json({ error: err.message, code: 'theme_limit_reached' })
      }
      throw err
    }
  })

  // PATCH /doc-themes/:id  { name }
  router.patch('/doc-themes/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = renameSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join('; '))
    }

    // RLS scopes the rename to the user's workspaces — a non-member gets null.
    const updated = await opts.docThemesStore.rename(userId, req.params.id, parsed.data.name)
    if (!updated) return notFound(res)
    res.json({ theme: toWire(updated) })
  })

  // POST /doc-themes/:id/refine  { instruction }
  // Conversational iteration: nudge the existing seed by a follow-up instruction
  // and rebuild the tokens in place. Not cap-affecting (it's an update).
  router.post('/doc-themes/:id/refine', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const parsed = refineSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join('; '))
    }

    // RLS-scoped read — a non-member (or missing id) gets null → 404.
    const theme = await opts.docThemesStore.getById(userId, req.params.id)
    if (!theme) return notFound(res)

    if (!opts.provider) {
      return res.status(503).json({ error: 'Theme generation is not available' })
    }

    let refined
    try {
      refined = await refineCustomTheme({
        provider: opts.provider,
        currentSeed: theme.seed,
        instruction: parsed.data.instruction,
      })
    } catch (err) {
      if (err instanceof ThemeGenerationError) {
        return res.status(422).json({ error: err.message })
      }
      throw err
    }

    const updated = await opts.docThemesStore.updateGenerated(userId, req.params.id, {
      seed: refined.seed,
      tokens: refined.tokens,
      description: refined.description,
    })
    if (!updated) return notFound(res)
    res.json({ theme: toWire(updated) })
  })

  // DELETE /doc-themes/:id
  router.delete('/doc-themes/:id', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) return unauthorized(res)

    const removed = await opts.docThemesStore.remove(userId, req.params.id)
    if (!removed) return notFound(res)
    res.status(204).end()
  })

  return router
}
