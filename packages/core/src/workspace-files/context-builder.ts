/**
 * Build the `# Workspace Files` L1 prompt block.
 *
 * Sits in the stable prefix of `buildFullSystemPrompt()` right after
 * `# Memories` (see `docs/architecture/context-engine/README.md`).
 * Folder-grouped, capped at the per-turn cap (50 by default — kept in
 * sync with `PER_TURN_FILES_INDEX_CAP` in chat.ts + channel-pipeline.ts).
 *
 * Always emits the block when called (with a "no files yet…" fallback)
 * — matches the memory-block "always emit if non-empty" semantics. The
 * caller decides whether to call this at all (gated on the `files`
 * capability for the assistant).
 */

import type { WorkspaceFileIndexRow } from './types.js'

const HEADER = '# Workspace Files'

const EMPTY_BODY =
  '(No files yet — they appear here as workspace members or assistants create them. Use fileWrite to save shared artifacts.)'

const PROLOGUE =
  'Files are workspace-shared. Every member can read them. Use the fileSearch / fileRead tools to access content beyond this index. Call fileSetMeta to label files you create or learn about.'

/**
 * Render one row. The format is intentionally compact:
 *   `<path> · <title or name> · <mime>` then optional summary line.
 * The model reliably picks paths out of this layout.
 */
function renderRow(row: WorkspaceFileIndexRow): string {
  const label = row.title && row.title.trim().length > 0 ? row.title : row.name
  const head = `${row.path} · ${label} · ${row.mime}`
  if (row.summary && row.summary.trim().length > 0) {
    return `${head}\n    ${row.summary}`
  }
  return head
}

/**
 * Group rows by `parentPath`. Folders appear in alphabetical order;
 * within a folder, rows preserve the input order (caller controls
 * ranking — typically `updated_at DESC`).
 */
function groupByFolder(rows: WorkspaceFileIndexRow[]): Map<string, WorkspaceFileIndexRow[]> {
  const groups = new Map<string, WorkspaceFileIndexRow[]>()
  for (const row of rows) {
    const folder = row.parentPath || '/'
    const existing = groups.get(folder)
    if (existing) {
      existing.push(row)
    } else {
      groups.set(folder, [row])
    }
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

export function buildWorkspaceFilesContext(rows: WorkspaceFileIndexRow[]): string {
  if (rows.length === 0) {
    return `${HEADER}\n${PROLOGUE}\n\n${EMPTY_BODY}`
  }

  const grouped = groupByFolder(rows)
  const sections: string[] = []
  for (const [folder, folderRows] of grouped) {
    const head = folder === '/' ? '/' : folder
    const body = folderRows.map(renderRow).join('\n')
    sections.push(`${head}\n${body}`)
  }
  return `${HEADER}\n${PROLOGUE}\n\n${sections.join('\n\n')}`
}
