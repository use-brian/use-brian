/** Strict, versioned wire contract for pre-filled Google Drive enrichment. */

import { z } from 'zod'

export const GDRIVE_OFFLINE_BUNDLE_SCHEMA_VERSION = 1 as const
export const GDRIVE_OFFLINE_IMPORT_MAX_FILES = 25

const nonBlank = (max: number) => z.string().trim().min(1).max(max)

export const gdriveOfflineEnrichmentEntrySchema = z.object({
  fileId: nonBlank(1024),
  version: nonBlank(256),
  name: nonBlank(1024),
  mimeType: nonBlank(512),
  modifiedTime: z.string().datetime({ offset: true }).optional(),
  webViewLink: z.string().url().max(4096).optional(),
  folderPath: z.array(nonBlank(512)).max(100).optional(),
  summary: nonBlank(20_000),
  keywords: z.array(nonBlank(200)).max(100).optional(),
  content: z.string().max(200_000).optional(),
}).strict()

export const gdriveOfflineEnrichmentBundleSchema = z.object({
  schemaVersion: z.literal(GDRIVE_OFFLINE_BUNDLE_SCHEMA_VERSION),
  source: z.literal('google-drive'),
  files: z.array(gdriveOfflineEnrichmentEntrySchema)
    .min(1)
    .max(GDRIVE_OFFLINE_IMPORT_MAX_FILES),
}).strict()

export type GDriveOfflineEnrichmentEntry = z.infer<typeof gdriveOfflineEnrichmentEntrySchema>
export type GDriveOfflineEnrichmentBundle = z.infer<typeof gdriveOfflineEnrichmentBundleSchema>

export function parseGDriveOfflineEnrichmentBundle(input: unknown):
  | { ok: true; value: GDriveOfflineEnrichmentBundle }
  | { ok: false; error: string } {
  const parsed = gdriveOfflineEnrichmentBundleSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue?.path.length ? issue.path.join('.') : 'bundle'
  return { ok: false, error: `${path}: ${issue?.message ?? 'Invalid enrichment bundle'}` }
}

/** Deterministic searchable artifact for an already-enriched offline entry. */
export function renderOfflineGDriveEnrichment(entry: GDriveOfflineEnrichmentEntry): string {
  const lines = [
    `# ${entry.name}`,
    '',
    '## Google Drive source',
    '',
    `- File ID: ${entry.fileId}`,
    `- Version: ${entry.version}`,
    `- MIME type: ${entry.mimeType}`,
  ]
  if (entry.modifiedTime) lines.push(`- Modified: ${entry.modifiedTime}`)
  if (entry.webViewLink) lines.push(`- Link: ${entry.webViewLink}`)
  if (entry.folderPath?.length) lines.push(`- Folder: ${entry.folderPath.join(' / ')}`)
  lines.push('', '## Summary', '', entry.summary)
  if (entry.keywords?.length) {
    lines.push('', '## Keywords', '', entry.keywords.join(', '))
  }
  if (entry.content?.trim()) {
    lines.push('', '## Source evidence', '', entry.content.trim())
  }
  return `${lines.join('\n')}\n`
}
