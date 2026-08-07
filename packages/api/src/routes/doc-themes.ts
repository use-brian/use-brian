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
  type GeneratedTheme,
} from '../doc/theme-generator.js'
import { brandThemeSeed, buildThemeTokens } from '@use-brian/shared'
import { getBrandStore } from '../db/brand-store.js'

export type DocThemesRouteOptions = {
  docThemesStore: DocThemeStore
  workspaceStore: WorkspaceStore
  /** Optional — when unset, POST (the only model-using route) returns 503. */
  provider?: LLMProvider
  /** Servable background-lane model, resolved at boot. */
  backgroundModel?: string
}

/**
 * Two ways to create a theme. `{ prompt }` asks a model to invent the anchor
 * colours; `{ fromBrand: true }` takes them from the workspace's approved
 * brand record — no model, no cost, exact brand values. A workspace that has
 * decided its colours should not have them guessed at.
 */
const createSchema = z.union([
  z.object({ prompt: z.string().trim().min(1).max(600) }).strict(),
  z.object({ fromBrand: z.literal(true) }).strict(),
])
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

    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return badRequest(res, parsed.error.issues.map((i) => i.message).join('; '))
    }
    const fromBrand = 'fromBrand' in parsed.data

    // The provider gate applies to the model path only — a brand-derived theme
    // needs no provider, so a deployment without one can still theme its docs.
    if (!fromBrand && !opts.provider) {
      return res.status(503).json({ error: 'Theme generation is not available' })
    }

    // Only the four fields the store needs — a brand-derived theme has no
    // model or token usage to report, and inventing zeros for them would put
    // a fake model attribution on a theme no model produced.
    let generated: Pick<GeneratedTheme, 'name' | 'description' | 'seed' | 'tokens'>
    let prompt: string
    if (fromBrand) {
      const brand = await getBrandStore().get(userId, workspaceId)
      const record = brand?.activeRecord
      if (!record) {
        return res.status(409).json({ error: 'This workspace has no approved brand to build a theme from.', code: 'no_approved_brand' })
      }
      const seed = brandThemeSeed({ name: record.naming.name, colors: record.colors })
      if (!seed) {
        // A partial brand produces no theme rather than a misleading one.
        return res.status(409).json({ error: 'The brand record has no usable hex colours to build a theme from.', code: 'no_brand_colors' })
      }
      generated = { name: seed.name, description: seed.description ?? null, seed, tokens: buildThemeTokens(seed) }
      prompt = `Derived from the ${record.naming.name} brand record`
    } else {
      prompt = (parsed.data as { prompt: string }).prompt
      try {
        generated = await generateCustomTheme({ provider: opts.provider!, prompt, model: opts.backgroundModel })
      } catch (err) {
        if (err instanceof ThemeGenerationError) {
          return res.status(422).json({ error: err.message })
        }
        throw err
      }
    }

    try {
      const created = await opts.docThemesStore.create({
        userId,
        workspaceId,
        name: generated.name,
        description: generated.description,
        prompt,
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
        model: opts.backgroundModel,
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
