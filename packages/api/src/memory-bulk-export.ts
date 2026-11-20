/** File formats for the workspace Memory download. [COMP:api/memory-bulk-export] */
import { z } from 'zod'
import { sanitize, type AnalyticsLogger } from '@use-brian/core/analytics/logger.js'
import type { Memory } from './db/memories.js'

export const memoryExportFormat = z.enum(['markdown', 'csv'])
export type MemoryExportFormat = z.infer<typeof memoryExportFormat>
export type MemoryExportEntitlement = (workspaceId: string) => Promise<boolean>
export type MemoryExportObserver = (input: {
  userId: string
  workspaceId: string
  format: MemoryExportFormat
  entrypoint: 'brain' | 'mcp'
  outcome: 'upgrade_required' | 'download_served'
}) => void

export function createMemoryExportObserver(analytics: Pick<AnalyticsLogger, 'logEvent'>): MemoryExportObserver {
  return ({ userId, workspaceId, format, entrypoint, outcome }) => analytics.logEvent({
    userId,
    eventName: `memory_bulk_export_${outcome}`,
    metadata: { workspace_id: sanitize(workspaceId), format: sanitize(format), entrypoint: sanitize(entrypoint) },
  })
}

const CSV_COLUMNS = ['id', 'summary', 'detail', 'created_at', 'updated_at', 'source', 'author_user_id', 'author_assistant_id']

function csvCell(value: string): string {
  // Spreadsheet apps may ignore padding or control characters before a formula.
  const safe = /^[\t\r\n]|^[\s\p{Cf}]*[=+\-@＝＋－＠]/u.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

function markdownInline(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').replace(/[\\`*_{}\[\]<>#!&|]/g, '\\$&')
}

export function memoryExportHeader(format: MemoryExportFormat): string {
  return format === 'csv' ? `${CSV_COLUMNS.join(',')}\r\n` : '# Brian memories\n\n'
}

export function serializeMemoryExportRow(format: MemoryExportFormat, memory: Memory): string {
  const created = memory.createdAt.toISOString()
  const updated = memory.updatedAt.toISOString()
  if (format === 'csv') {
    return [
      memory.id, memory.summary, memory.detail ?? '', created, updated, memory.source,
      memory.createdByUserId ?? '', memory.createdByAssistantId ?? '',
    ].map(csvCell).join(',') + '\r\n'
  }
  const provenance = [
    `- ID: ${markdownInline(memory.id)}`,
    `- Created: ${created}`,
    `- Updated: ${updated}`,
    `- Source: ${markdownInline(memory.source)}`,
    ...(memory.createdByUserId ? [`- Author (user): ${markdownInline(memory.createdByUserId)}`] : []),
    ...(memory.createdByAssistantId ? [`- Author (assistant): ${markdownInline(memory.createdByAssistantId)}`] : []),
  ]
  // Preserve detail verbatim in a plain-text block, including literal Markdown.
  let detail = ''
  if (memory.detail) {
    let fenceLength = 3
    for (const [run] of memory.detail.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run.length + 1)
    const fence = '`'.repeat(fenceLength)
    detail = `\n${fence}text\n${memory.detail}\n${fence}\n`
  }
  return `## ${markdownInline(memory.summary)}\n\n${provenance.join('\n')}\n${detail}\n`
}

export function memoryExportFilename(format: MemoryExportFormat): string {
  return format === 'csv' ? 'brian-memories.csv' : 'brian-memories.md'
}
