/** Native attachment parsing with exact workspace-file ancestry. [COMP:api/workspace-mcp] */
import { documentMimeType, parseFileContent, scopeEvidenceFromRows, type FilesApi, type ToolContext } from '@use-brian/core'
import { writeRetainedContextFrame } from '../db/session-context-revisions.js'
import { assertSourceModelInputAuthority } from '../application-platform/model-source-authority.js'

const MAX_WORKSPACE_ATTACHMENT_BYTES = 20 * 1024 * 1024

export async function attachWorkspaceFiles(files: FilesApi, context: ToolContext, ids: readonly string[]): Promise<string[]> {
  const execution = context.executionContext, accumulator = context.scopeAccumulator
  if (!execution || !accumulator || !context.workspaceId || !context.sessionPersisted) throw new Error('attachment_context_unavailable')
  const attached: string[] = []
  for (const id of new Set(ids)) {
    await execution.security.authority.assertCurrent()
    const access = execution.security.access
    const readContext = { ...access, executionContext: execution }
    // Bound storage reads before allocating/parsing the native attachment.
    const metadata = await files.stat(readContext, id)
    if (!metadata.ok || metadata.value.sizeBytes > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new Error('attachment_unavailable_or_too_large')
    const result = await files.readBytes(readContext, id)
    if (!result.ok || result.value.bytes.length > MAX_WORKSPACE_ATTACHMENT_BYTES) throw new Error('attachment_unavailable_or_too_large')
    const { file, bytes } = result.value
    const evidence = scopeEvidenceFromRows([file])
    if (evidence.sources?.length !== 1 || !file.scopeVersion) throw new Error('attachment_source_unavailable')
    accumulator.note(evidence)
    await assertSourceModelInputAuthority(context)
    const parsed = await parseFileContent(Buffer.from(bytes), file.mime, file.name)
    const mime = parsed.mediaMimeType ?? (parsed.detectedFormat ? documentMimeType(parsed.detectedFormat) : file.mime)
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
    const cachedId = await writeRetainedContextFrame({ execution, accumulator }, accumulator.evidence.sources ?? [], async client => {
      const source = (await client.query(`SELECT id FROM workspace_files WHERE id=$1 AND workspace_id=$2 AND scope_version=$3
        AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held FOR SHARE`, [file.id, context.workspaceId, file.scopeVersion])).rows[0]
      if (!source) throw new Error('attachment_source_changed')
      const row = (await client.query<{ id: string }>(`INSERT INTO file_cache
        (session_id,file_name,mime_type,content,summary,size_bytes,expires_at,workspace_id,user_id,assistant_id,
         sensitivity,compartments,project_ids,original_content,source_file_id,source_file_version)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '7 days',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [context.sessionId,file.name,mime,parsed.mediaMimeType ? dataUrl : parsed.text,parsed.summary ?? null,bytes.length,
        context.workspaceId,file.userId ?? null,file.assistantId ?? null,file.sensitivity,file.compartments ?? [],file.projectIds ?? [],
        !parsed.mediaMimeType && parsed.detectedFormat ? dataUrl : null,file.id,file.scopeVersion])).rows[0]
      if (!row) throw new Error('attachment_source_unavailable')
      return row.id
    })
    attached.push(cachedId)
  }
  return attached
}
