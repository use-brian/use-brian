/**
 * Shared internals for the workspace-file chat tools (`tools.ts`,
 * `send-file.ts`). Extracted so `send-file.ts` doesn't import from
 * `tools.ts` (which imports it back — cycle).
 */

import { z } from 'zod'
import type { FilesContext, FilesError } from './api.js'

export const idOrPathShape = z.string().min(1).max(1024)

export function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'Files require a workspace. This assistant is not bound to one — switch to a workspace-scoped chat to manage files.',
      isError: true,
    }
  }
  return null
}

export function ctxFor(context: {
  userId: string
  workspaceId?: string | null
  assistantId?: string | null
  assistantKind?: FilesContext['assistantKind']
  clearance?: FilesContext['clearance']
  compartments?: FilesContext['compartments']
}): FilesContext {
  return {
    userId: context.userId,
    workspaceId: context.workspaceId!,
    assistantId: context.assistantId ?? null,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
  }
}

export function errorMessage(err: FilesError): string {
  switch (err.kind) {
    case 'quota_exceeded':
      return `Workspace storage quota exceeded — using ${err.currentBytes} of ${err.limitBytes} bytes; this write would add ${err.attemptedBytes} more. Delete files to free space.`
    case 'not_found':
      return `File ${err.reference} not found in this workspace.`
    case 'conflict':
      return `A file already exists at ${err.path}. Pass an existing id (or delete first) to overwrite.`
  }
}
