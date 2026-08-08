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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Mimes whose bytes a UTF-8 decode destroys. The allow-list is inverted on
 * purpose: `text/*` and the handful of structured text types are readable and
 * everything else is assumed binary, so a new format defaults to REFUSING a
 * lossy read rather than silently returning mojibake.
 *
 * Office documents (`.docx`/`.xlsx`/`.pptx`) are binary containers, but they
 * are parsed to Markdown at the upload boundary and stored as text, so they
 * are not listed — a stored office file's `mime` is whatever the write set.
 * The check is on what the row claims to hold, not on the original format.
 */
const TEXT_MIME_RE =
  /^text\/|^application\/(json|xml|x-ndjson|yaml|x-yaml|javascript|typescript|sql|toml)(;|$)|\+json$|\+xml$/i

export function isBinaryMime(mime: string): boolean {
  return !TEXT_MIME_RE.test(mime.trim())
}

/**
 * A `not_found` on a bare UUID is overwhelmingly likely to be an UPLOAD id,
 * not a bad stored-file id: the only place a model gets a naked file UUID is
 * an `<attached_file id="…">` tag, and that tag carries a transient
 * `file_cache` row, not a `workspace_files` row. The two id spaces are
 * indistinguishable by shape.
 *
 * The flat "not found in this workspace" this replaced was a dead end. On
 * 2026-08-05 a model passed two `<attached_file>` ids straight to
 * `gmailSendMessage(attachments)` — the right instinct — got that message,
 * and had nowhere to go: it tried a re-ingest tool (same flat error), then
 * web-searched "how to find workspace file id Use Brian", then sent the
 * email with no attachments. Every layer was individually correct and the
 * user got an email promising photos that were not on it.
 *
 * The remedy is stated tool-agnostically per the Layer-1 tool-awareness
 * rule: an assistant without the `files` capability has no promote tool, and
 * naming one it cannot call is the exact failure this whole change is
 * closing. It is told what to do and what to say if it cannot.
 */
export function errorMessage(err: FilesError): string {
  switch (err.kind) {
    case 'quota_exceeded':
      return `Workspace storage quota exceeded — using ${err.currentBytes} of ${err.limitBytes} bytes; this write would add ${err.attemptedBytes} more. Delete files to free space.`
    case 'not_found':
      return UUID_RE.test(err.reference.trim())
        ? `No workspace file matches ${err.reference}. If that id came from an <attached_file id="…"> tag it is an UPLOADED attachment, not a stored file — uploads must be saved into the workspace files first, and the save returns the durable path you then pass here. Save it, then retry with the returned path. If you have no tool to save uploaded files, tell the user plainly that this assistant cannot keep or attach files and that Workspace files must be turned on for it in Studio → the assistant → Capabilities — never claim a file was attached when it was not, and never substitute a text note for the file.`
        : `File ${err.reference} not found in this workspace.`
    case 'conflict':
      return `A file already exists at ${err.path}. Pass an existing id (or delete first) to overwrite.`
  }
}
