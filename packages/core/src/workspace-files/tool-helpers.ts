/**
 * Shared internals for the workspace-file chat tools (`tools.ts`,
 * `send-file.ts`). Extracted so `send-file.ts` doesn't import from
 * `tools.ts` (which imports it back — cycle).
 */

import { z } from 'zod'
import type { FilesContext, FilesError } from './api.js'

export const idOrPathShape = z.string().min(1).max(1024)

// ── Tool-policy gate ───────────────────────────────────────────
//
// The Studio ▸ Connectors and Assistant ▸ Tools surfaces write per-tool
// allow/ask/block policy for the `files` built-in (serverName='files' in
// `mcp_tool_settings`), but the files tools are constructed once at boot —
// they can't read the store directly (core is store-agnostic). Boot wires
// this hook to the same L1 (app-level) + L2 (per-assistant) strictest-wins
// resolution the UI displays; when it's absent (open default, tests) the
// tools' static `requiresConfirmation` flags stand and nothing blocks.
// See docs/architecture/features/files.md → "Connector-style governance".

export type FileToolPolicy = 'allow' | 'ask' | 'block'

export type ResolveFileToolPolicy = (
  toolName: string,
  context: { userId: string; assistantId: string },
) => Promise<FileToolPolicy>

/** Per-tool `resolveConfirmation` hook — dynamic policy overrides the
 *  static flag only when the boot wired a resolver. */
export function policyConfirmation(
  resolvePolicy: ResolveFileToolPolicy | undefined,
  toolName: string,
): ((context: { userId: string; assistantId: string }) => Promise<boolean>) | undefined {
  if (!resolvePolicy) return undefined
  return async (context) => (await resolvePolicy(toolName, context)) === 'ask'
}

/** Execute-time block gate — mirrors the MCP connector wrapper: a blocked
 *  tool returns an isError result instead of running. Fail-open on a
 *  resolver error (policy lookup outage must not take down file tools). */
export async function policyBlockGate(
  resolvePolicy: ResolveFileToolPolicy | undefined,
  toolName: string,
  context: { userId: string; assistantId: string },
): Promise<{ data: string; isError: true } | null> {
  if (!resolvePolicy) return null
  try {
    if ((await resolvePolicy(toolName, context)) === 'block') {
      return {
        data: `ERROR: "${toolName}" is blocked by tool policy for this assistant. A workspace member can change it under Studio > Connectors > Workspace Files.`,
        isError: true,
      }
    }
  } catch {
    return null
  }
  return null
}

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
