import {
  workspaceFilesCtxFor, minSensitivity, scopeEvidenceFromRows,
  type FilesApi, type ToolContext, type Sensitivity, type CreateComputerToolsOptions,
} from '@use-brian/core'

/** Browser transfers use the same file authority and provenance as durable file tools. */
export function createBrowserFileBridge(api: FilesApi, clearanceFor: (assistantId: string) => Promise<Sensitivity>,
  prepareWrite: NonNullable<CreateComputerToolsOptions['files']>['prepareWrite']) {
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
    prepareWrite,
  }
}
