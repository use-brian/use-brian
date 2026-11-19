/** Hosted download of the current workspace Memory view. [COMP:api/memory-bulk-export] */
import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Router } from 'express'
import { z } from 'zod'
import { DerivedScopeError, type ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { isAuthorityChangedError } from '../context-scope/authority-lease.js'
import { listWorkspaceMemoryExportPage } from '../db/memories.js'
import { readRetainedContextFrame } from '../db/session-context-revisions.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { memoryExportFilename, memoryExportFormat, memoryExportHeader, serializeMemoryExportRow, type MemoryExportEntitlement, type MemoryExportObserver } from '../memory-bulk-export.js'
import { resolveNativeWorkspaceReadAuthority } from './native-workspace-read-authority.js'
import { pinSessionTitleClaims } from './session-title-authority.js'

const input = z.object({ workspaceId: z.string().uuid(), format: memoryExportFormat }).strict()
const EXPORT_TIMEOUT_MS = 90_000

export function brainMemoryExportRoutes(entitled: MemoryExportEntitlement, observe?: MemoryExportObserver): Router {
  const router = Router()
  const activeExports = new Set<string>()

  router.post('/memories/export', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const claims = pinSessionTitleClaims(req)
    if (!claims) { res.status(401).json({ error: 'authentication_required' }); return }
    const request = input.safeParse(req.body)
    if (!request.success) { res.status(400).json({ error: 'invalid_memory_export' }); return }
    const { workspaceId, format } = request.data
    const exportKey = `${claims.userId}:${workspaceId}`
    if (activeExports.has(exportKey)) { res.status(409).json({ error: 'memory_export_in_progress' }); return }

    activeExports.add(exportKey)
    const cancelled = new AbortController()
    const timeout = AbortSignal.timeout(EXPORT_TIMEOUT_MS)
    const signal = AbortSignal.any([cancelled.signal, timeout])
    const close = () => { if (!res.writableFinished) cancelled.abort() }
    res.once('close', close)
    let directory: string | undefined
    try {
      const authority = await resolveNativeWorkspaceReadAuthority({ claims, workspaceId, abortSignal: signal })
      const sendPlanPrompt = async () => {
        const role = await getWorkspaceRoleSystem(claims.userId, workspaceId, true)
        await authority.execution.security.authority.assertCurrent()
        if (!role) throw new DerivedScopeError('scope_evidence_missing')
        signal.throwIfAborted()
        res.status(402).json({ error: 'paid_memory_export_required', canManageBilling: role === 'owner' })
        observe?.({ userId: claims.userId, workspaceId, format, entrypoint: 'brain', outcome: 'upgrade_required' })
      }
      if (!await entitled(workspaceId)) { await sendPlanPrompt(); return }
      directory = await mkdtemp(join(tmpdir(), 'brian-memory-export-'))
      const path = join(directory, memoryExportFilename(format))
      const file = await open(path, 'wx', 0o600)
      const sourcesByPage: ScopeSource[][] = []
      try {
        await file.writeFile(memoryExportHeader(format))
        let after: string | null = null
        do {
          signal.throwIfAborted()
          const page = await listWorkspaceMemoryExportPage(authority, after)
          await file.writeFile(page.memories.map(memory => serializeMemoryExportRow(format, memory)).join(''))
          if (page.sources.length > 0) sourcesByPage.push(page.sources)
          after = page.next
        } while (after)
      } finally {
        await file.close()
      }

      // Re-admit the exported source versions before handing off any bytes.
      for (const sources of sourcesByPage) {
        signal.throwIfAborted()
        await readRetainedContextFrame(authority, sources, async () => undefined)
      }
      const size = (await stat(path)).size
      const allowed = await entitled(workspaceId)
      await authority.execution.security.authority.assertCurrent()
      signal.throwIfAborted()
      if (!allowed) { await sendPlanPrompt(); return }
      res.set({
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${memoryExportFilename(format)}"`,
        'Content-Length': String(size),
        'X-Content-Type-Options': 'nosniff',
      })
      await pipeline(createReadStream(path), res, { signal })
      observe?.({ userId: claims.userId, workspaceId, format, entrypoint: 'brain', outcome: 'download_served' })
    } catch (error) {
      if (cancelled.signal.aborted || res.headersSent || res.destroyed) return
      if (timeout.aborted) { res.status(503).json({ error: 'memory_export_timed_out' }); return }
      if (error instanceof DerivedScopeError || isAuthorityChangedError(error)
        || error instanceof SourceProtocolError && error.code === 'source_access_denied') {
        res.status(404).json({ error: 'memory_export_access_unavailable' })
        return
      }
      res.status(503).json({ error: 'memory_export_unavailable' })
    } finally {
      res.off('close', close)
      activeExports.delete(exportKey)
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {
        console.error('[memory-export] temporary file cleanup failed')
      })
    }
  })
  return router
}
