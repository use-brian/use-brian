import { createHash } from 'node:crypto'
import {
  workspaceFilesCtxFor, minSensitivity, maxSensitivity, scopeEvidenceFromRows,
  type FilesApi, type ToolContext, type Sensitivity,
} from '@use-brian/core'

/** Browser transfers use the same file authority and provenance as durable file tools. */
export function createBrowserFileBridge(api: FilesApi, clearanceFor: (assistantId: string) => Promise<Sensitivity>) {
  async function authority(context: ToolContext) {
    if (!context.workspaceId) throw new Error('Workspace required')
    return workspaceFilesCtxFor({ ...context,
      clearance: minSensitivity(context.clearance ?? 'confidential', await clearanceFor(context.assistantId)),
    })
  }
  return {
    async readBytes(context: ToolContext, fileId: string) {
      const ctx = await authority(context)
      // Bound before loading the object; readBytes rechecks live authorization.
      const stat = await api.stat(ctx, fileId)
      if (!stat.ok) throw new Error('Workspace file is unavailable or unauthorized.')
      if (stat.value.sizeBytes > 4 * 1024 * 1024) throw new Error('Upload exceeds the 4 MiB limit.')
      const read = await api.readBytes(ctx, fileId)
      if (!read.ok) throw new Error('Workspace file is unavailable or unauthorized.')
      if (read.value.bytes.byteLength > 4 * 1024 * 1024) throw new Error('Upload exceeds the 4 MiB limit.')
      context.scopeAccumulator?.note(scopeEvidenceFromRows([read.value.file]))
      return { bytes: read.value.bytes, name: read.value.file.path.split('/').pop() || 'upload' }
    },
    async writeBytes(context: ToolContext, file: { path: string; name: string; mime: string; bytes: Uint8Array }) {
      const base = await authority(context)
      // Browser sessions can contain private authenticated content. Conservatively
      // label at the effective clearance, never below the turn's evidence floor.
      const ctx = { ...base, writeSensitivity: maxSensitivity(context.scopeAccumulator?.sensitivity ?? 'public', base.clearance ?? 'confidential') }
      const stamp = createHash('sha256').update(JSON.stringify([ctx.writeSensitivity,
        [...(ctx.writeCompartments ?? [])].sort(), [...(ctx.writeProjectIds ?? [])].sort()])).digest('hex')
      const path = file.path.replace('/browser-downloads/', `/browser-downloads/${stamp}/`)
      const saved = await api.writeBytes(ctx, { path, bytes: file.bytes, mime: file.mime,
        title: file.name, sensitivity: ctx.writeSensitivity })
      if (saved.ok) {
        context.scopeAccumulator?.note(scopeEvidenceFromRows([saved.value]))
        return { fileId: saved.value.id, path: saved.value.path }
      }
      // Idempotent pagination without a cache. Verify live read authority and
      // exact bytes; never adopt or overwrite an unrelated path collision.
      if (saved.error.kind === 'conflict') {
        const read = await api.readBytes(ctx, path)
        const sameSet = (a: string[] | undefined, b: string[] | undefined) =>
          JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort())
        if (read.ok && read.value.file.createdByAssistantId === context.assistantId &&
          read.value.file.createdByUserId === context.userId && read.value.file.sensitivity === ctx.writeSensitivity &&
          sameSet(read.value.file.compartments, ctx.writeCompartments) && sameSet(read.value.file.projectIds, ctx.writeProjectIds) &&
          Buffer.from(read.value.bytes).equals(Buffer.from(file.bytes))) {
          context.scopeAccumulator?.note(scopeEvidenceFromRows([read.value.file]))
          return { fileId: read.value.file.id, path: read.value.file.path }
        }
      }
      throw new Error('Could not persist browser download (authorization, quota, or conflict).')
    },
  }
}
