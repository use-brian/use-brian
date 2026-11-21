/**
 * Build the `# Workspace Files` L1 prompt block.
 *
 * Sits in the stable prefix of `buildFullSystemPrompt()` right after
 * `# Memories` (see `docs/architecture/context-engine/README.md`).
 * Folder-grouped, capped at the per-turn cap (50 by default — kept in
 * sync with `PER_TURN_FILES_INDEX_CAP` in chat.ts + channel-pipeline.ts).
 *
 * The caller decides whether to include the block. A failed or unadmitted
 * lookup supplies null, while an empty array records a successful scoped read.
 */

import type { WorkspaceFileIndexRow } from './types.js'

const HEADER = '# Workspace Files'

const EMPTY_BODY =
  'The workspace file index returned no entries within this turn’s access. Use an available file search tool to check for a specific file.'

const UNAVAILABLE_BODY =
  'The workspace file index is unavailable for this turn. Use an available file tool to verify a file’s existence or contents.'

const PROLOGUE =
  'Recent workspace files available to this turn. Use an available file search tool to look beyond the index and a file read tool to verify content.'

/** Preserve the original row references so evidence matches the rendered index. */
export function selectWorkspaceFilesContextRows(
  rows: readonly WorkspaceFileIndexRow[], limit = rows.length,
): readonly WorkspaceFileIndexRow[] {
  const selected = rows.filter(row => row.purpose !== 'engineering_archive').slice(0, limit)
  return selected.length === rows.length ? rows : selected
}

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
function groupByFolder(rows: readonly WorkspaceFileIndexRow[]): Map<string, WorkspaceFileIndexRow[]> {
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

export function buildWorkspaceFilesContext(rows: readonly WorkspaceFileIndexRow[] | null): string {
  if (rows === null) return `${HEADER}\n${UNAVAILABLE_BODY}`
  const selected = selectWorkspaceFilesContextRows(rows)
  if (!selected.length) return `${HEADER}\n${EMPTY_BODY}`

  const grouped = groupByFolder(selected)
  const sections: string[] = []
  for (const [folder, folderRows] of grouped) {
    const head = folder === '/' ? '/' : folder
    const body = folderRows.map(renderRow).join('\n')
    sections.push(`${head}\n${body}`)
  }
  return `${HEADER}\n${PROLOGUE}\n\n${sections.join('\n\n')}`
}
