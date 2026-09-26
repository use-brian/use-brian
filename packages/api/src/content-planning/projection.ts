/** Shared accepted-content, readiness and manual delivery boundary. [COMP:feed/draft-projection] */
import JSZip from 'jszip'
import { FEED_MEDIA_CAPS, FEED_TEXT_CAPS, type FeedComposition, type FeedTarget, type FeedLinkedInIssue } from '@use-brian/shared'
import { projectFeedLinkedIn, projectFeed, walkFeed, feedCompositionHtml, feedText, canonicalFeedValue } from '@use-brian/doc-model'
import type { FilesApi } from '@use-brian/core'
import { withFeedTransaction, readFeedCopy, requireFeedComposition, assertFeedFiles, FeedCollaborationError, type FeedActor, type StructuredFeedContent } from '../db/feed-collaboration-store.js'
import { query } from '../db/client.js'
export type FeedReadinessIssue = { code: FeedLinkedInIssue['code'] | 'unfinished_slot' | 'empty_post' | 'text_limit' | 'media_limit' | 'duplicate_media' | 'unsupported_format' | 'invalid_thread' | 'article_fields'; target: FeedTarget }
export function feedOutputProjection(content: StructuredFeedContent, platform: string) {
  const projection = projectFeed(content.composition); const issues: FeedReadinessIssue[] = []
  if (platform === 'linkedin') {
    const linkedin = projectFeedLinkedIn(content.composition, content.linkedin, content)
    const missing = walkFeed(content.composition).filter(r => r.node.type === 'generationPlaceholder').map(r => ({ kind: 'block' as const, segmentId: r.segmentId, blockId: r.node.attrs.id }))
    return { ...projection, text: linkedin.text, plainText: linkedin.text, threadSegments: [linkedin.text], html: feedCompositionHtml(content.composition),
      issues: linkedin.blockers.map(issue => ({ code: issue.code, target: { kind: 'post' as const } })), missing,
      manualArticle: linkedin.mode === 'newsletter_edition' || linkedin.mode === 'legacy_article', platform,
      postFormat: content.postFormat, article: content.article, linkedin }
  }
  const format = content.postFormat ?? 'post'; const rows = walkFeed(content.composition)
  const missing = rows.filter(item => item.node.type === 'generationPlaceholder').map(item => ({ kind: 'block' as const, segmentId: item.segmentId, blockId: item.node.attrs.id }))
  issues.push(...missing.map(target => ({ code: 'unfinished_slot' as const, target })))
  const plainSegments = content.composition.segments.map(segment => segment.content.map(feedText).filter(Boolean).join('\n\n'))
  if (!plainSegments.some(text => text.trim()) && !projection.media.length) issues.push({ code: 'empty_post', target: { kind: 'post' } })
  if (!(platform in FEED_MEDIA_CAPS) || format === 'thread' && platform !== 'twitter' || format === 'article' && platform !== 'linkedin') issues.push({ code: 'unsupported_format', target: { kind: 'post' } })
  if (format === 'thread' && (plainSegments.length < 2 || plainSegments.length > 25 || plainSegments.some(text => !text.trim()))) issues.push({ code: 'invalid_thread', target: { kind: 'post' } })
  // Native article publishing is unavailable. Inline articles use the ZIP;
  // legacy link-card articles retain their existing source/title contract.
  const manualArticle = format === 'article' && projection.inlineImages.length > 0
  if (format === 'article' && !manualArticle && (!content.article?.title.trim() || !/^https?:\/\//i.test(content.article?.sourceUrl ?? ''))) issues.push({ code: 'article_fields', target: { kind: 'post' } })
  if (!manualArticle) for (let i = 0; i < plainSegments.length; i++) {
    const text = plainSegments[i]!; const length = platform === 'twitter' ? feedXLength(text) : text.length
    if (length > (FEED_TEXT_CAPS[platform] ?? 100_000)) issues.push({ code: 'text_limit', target: { kind: 'block', segmentId: content.composition.segments[i]!.id, blockId: content.composition.segments[i]!.content[0]!.attrs.id } })
  }
  if (projection.media.length > (FEED_MEDIA_CAPS[platform] ?? 1)) issues.push({ code: 'media_limit', target: { kind: 'post' } })
  if (new Set(projection.media.map(item => item.fileId)).size !== projection.media.length) issues.push({ code: 'duplicate_media', target: { kind: 'post' } })
  return { ...projection, linkedin: undefined, plainText: plainSegments.join('\n\n'), html: feedCompositionHtml(content.composition), issues, missing, manualArticle, platform, postFormat: format, article: content.article }
}
export function feedXLength(text: string): number {
  const points = (value: string) => [...value].reduce((sum, char) => { const p = char.codePointAt(0)!; return sum + (p <= 4351 || p >= 8192 && p <= 8205 || p >= 8208 && p <= 8223 || p >= 8242 && p <= 8247 ? 1 : 2) }, 0)
  let total = 0; let cursor = 0
  for (const match of text.matchAll(/https?:\/\/[^\s]+/gu)) { total += points(text.slice(cursor, match.index)) + 23; cursor = match.index! + match[0].length }
  return total + points(text.slice(cursor))
}
export type FeedSavedCanonical = { revision: number; content: StructuredFeedContent }
export async function readFeedSaveProjection(actor: FeedActor, expectedRevision: unknown, platform: string) {
  // Legacy saves keep their established contract. An upgraded row always
  // enters the locked command authority and requires an explicit revision.
  const row = (await query('SELECT content FROM feed_post_working_copies WHERE session_id=$1', [actor.sessionId])).rows[0]
  if (row?.content?.schemaVersion !== 2) return null
  return withFeedTransaction(actor, async (client, scope) => {
    const copy = await readFeedCopy(client, actor.sessionId)
    if (!copy || !Number.isSafeInteger(expectedRevision) || copy.revision !== expectedRevision) throw new FeedCollaborationError(409, 'revision_conflict')
    const content = requireFeedComposition(copy.content); await assertFeedFiles(client, actor, scope, content.composition, [], content.linkedin)
    return { projection: feedOutputProjection(content, platform), canonical: { revision: copy.revision, content } satisfies FeedSavedCanonical }
  })
}
export async function assertFeedSavedReady(actor: FeedActor, canonical: FeedSavedCanonical | undefined, platform: string) {
  const current = (await query('SELECT content FROM feed_post_working_copies WHERE session_id=$1', [actor.sessionId])).rows[0]
  if (current?.content?.schemaVersion !== 2 && !canonical) return null
  if (!canonical) throw new FeedCollaborationError(409, 'save_current_composition_required')
  const saved = await readFeedSaveProjection(actor, canonical.revision, platform)
  if (!saved) throw new FeedCollaborationError(409, 'save_current_composition_required')
  if (canonicalFeedValue(saved.canonical.content) !== canonicalFeedValue(canonical.content)) throw new FeedCollaborationError(409, 'saved_composition_conflict')
  if (saved.projection.issues.length) throw new FeedCollaborationError(409, saved.projection.issues[0]!.code)
  if (platform !== 'email' && saved.canonical.content.sourceSensitivity && saved.canonical.content.sourceSensitivity !== 'public') {
    const release = (await query('SELECT public_release FROM feed_post_working_copies WHERE session_id=$1', [actor.sessionId])).rows[0]?.public_release
    if (release?.audience !== 'public' || release.revision !== canonical.revision) throw new FeedCollaborationError(409, 'public_release_required')
  }
  return saved
}
const extension = (mime: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[mime] ?? 'bin'
export async function exportFeedArticle(actor: FeedActor, expectedRevision: number, acknowledgeOmissions: boolean, files?: FilesApi) {
  const saved = await withFeedTransaction(actor, async (client, scope) => {
    const copy = await readFeedCopy(client, actor.sessionId)
    if (!copy || copy.revision !== expectedRevision) throw new FeedCollaborationError(409, 'revision_conflict')
    const content = requireFeedComposition(copy.content); await assertFeedFiles(client, actor, scope, content.composition, [], content.linkedin)
    const projection = projectFeed(content.composition)
    if (content.linkedin?.mode === 'newsletter_edition' && projectFeedLinkedIn(content.composition,content.linkedin,content).blockers.length) throw new FeedCollaborationError(409,'newsletter_not_ready')
    if (projection.missingSlots.length && !acknowledgeOmissions) throw new FeedCollaborationError(409, 'acknowledge_omitted_slots')
    return { content, projection, scope }
  }, false)
  const zip = new JSZip(); const date = new Date('1980-01-01T00:00:00Z'); const assetPath = (id: string, mime: string) => `assets/${id}.${extension(mime)}`
  let total = 0
  const manifest: Array<{fileId:string;path:string;alt:string;blockId?:string;placement:string}> = []
  const allMedia = [...saved.projection.media]
  const cover = saved.content.linkedin?.newsletter?.coverFileId
  if (cover && !allMedia.some(m=>m.fileId===cover)) {
    if(!files)throw new FeedCollaborationError(503,'image_storage_unavailable')
    const row=await files.readBytes({workspaceId:saved.scope.workspaceId,userId:actor.userId,assistantId:actor.assistantId,assistantKind:'app',clearance:saved.scope.memberClearance as 'public'|'internal'|'confidential',compartments:saved.scope.memberCompartments},cover)
    if(!row.ok)throw new FeedCollaborationError(403,'file_unavailable')
    total+=row.value.bytes.length
    if(total>100*1024*1024)throw new FeedCollaborationError(413,'article_assets_too_large')
    zip.file(assetPath(cover,row.value.file.mime),row.value.bytes,{date})
    manifest.push({fileId:cover,path:assetPath(cover,row.value.file.mime),alt:saved.content.linkedin?.newsletter?.coverCaption??'',placement:'cover'})
  }
  for (const media of allMedia) {
    if (!files) throw new FeedCollaborationError(503, 'image_storage_unavailable')
    const result = await files.readBytes({ workspaceId: saved.scope.workspaceId, userId: actor.userId, assistantId: actor.assistantId, assistantKind: 'app', clearance: saved.scope.memberClearance as 'public' | 'internal' | 'confidential', compartments: saved.scope.memberCompartments }, media.fileId)
    if (!result.ok || result.value.file.mime !== media.mimeType) throw new FeedCollaborationError(403, 'file_unavailable')
    total += result.value.bytes.length
    if (total > 100 * 1024 * 1024) throw new FeedCollaborationError(413, 'article_assets_too_large')
    zip.file(assetPath(media.fileId, media.mimeType), result.value.bytes, { date })
    const block=walkFeed(saved.content.composition).find(r=>r.node.type==='image'&&r.node.attrs.fileId===media.fileId)
    manifest.push({fileId:media.fileId,path:assetPath(media.fileId,media.mimeType),alt:media.alt??'',blockId:block?.node.attrs.id,placement:block?.node.type==='image'?block.node.attrs.placement:'attachment'})
  }
  // Recheck after potentially slow byte reads before exposing the archive.
  await withFeedTransaction(actor, async (client, scope) => {const current=await readFeedCopy(client,actor.sessionId);if(current?.revision!==expectedRevision)throw new FeedCollaborationError(409,'revision_conflict');await assertFeedFiles(client, actor, scope, saved.content.composition, [], saved.content.linkedin)}, false)
  const html = feedCompositionHtml(saved.content.composition, assetPath)
  zip.file('article.html', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Article</title><style>body{max-width:72ch;margin:2rem auto;padding:0 1rem;font:18px/1.6 system-ui}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`, { date })
  const context=saved.content.linkedin
  zip.file('article.txt',projectFeedLinkedIn(saved.content.composition,context,saved.content).text,{date})
  zip.file('manifest.json',JSON.stringify({version:1,revision:expectedRevision,title:context?.newsletter?.editionTitle??saved.content.title,author:{kind:context?.authorKind??'person',display:context?.authorDisplay??'',destinationId:context?.destinationId??null},newsletter:context?.newsletter??null,assets:manifest},null,2)+'\n',{date})
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX' })
}
