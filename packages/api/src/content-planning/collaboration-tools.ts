import {createLinkedInPromotion,completeLinkedInManual,linkedinManualCommand} from './linkedin-newsletter.js'
import {feedLinkedInPublisher} from './linkedin-authority.js'
import { readLinkedInPreview } from './linkedin-payload.js'
import { loadFeedReviewContext, type FeedReviewContextLoader } from './review-context.js'
import type { FeedGenerationService } from './generation.js'
/** Selection-bound Feed tools use the UI's domain service. [COMP:feed/draft-suggestions] */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'
import { feedCommandRequestSchema, feedEditSchema, feedTargetSchema, feedReviewRequestSchema, feedGenerationEstimateRequestSchema, feedGenerationRequestSchema, feedPlaceholderAttrsSchema, feedMediaSchema, feedConfirmationRequestSchema, feedLearningCommandRequestSchema, type FeedEdit } from '@use-brian/shared'
import { proposeFeedReplacement, insertFeedPlaceholder, locateFeedNode, duplicateFeedNode, feedParagraph } from '@use-brian/doc-model'
import { feedCommand, readReviewedFeedCollaboration, type FeedTurnContext } from './collaboration-service.js'
import { FeedCollaborationError } from '../db/feed-collaboration-store.js'
import { buildProposeDraftsTool } from './draft-tool.js'
import { requestFeedReview } from './review.js'
import { summarizeFeedRun, getFeedRun, cancelFeedRun, retryFeedRun } from '../db/feed-editorial-runs-store.js'
import { confirmFeedPost } from './confirmation.js'
import { executeFeedLearningCommand, readFeedLearnedDecisions } from './learning.js'
const uuid = z.string().uuid()
function selectedEdits(context: FeedTurnContext, edits: FeedEdit[]) {
  const target = context.reference.target
  if (!target || target.kind === 'post') return
  for (const edit of edits) {
    if (target.kind === 'range') {
      if (edit.kind !== 'replaceText' || edit.spans.some(span => !target.spans.some(t => span.segmentId === t.segmentId && span.blockId === t.blockId && span.from >= t.from && span.to <= t.to))) throw new FeedCollaborationError(403, 'selection_scope_mismatch')
    } else if (edit.kind === 'joinBlocks' || !('blockId' in edit) || edit.segmentId !== target.segmentId || edit.blockId !== target.blockId) throw new FeedCollaborationError(403, 'selection_scope_mismatch')
  }
}
export function buildFeedCollaborationTools(context: FeedTurnContext, sourceMessageId?: string, generation?: FeedGenerationService, loadContext: FeedReviewContextLoader = loadFeedReviewContext): Tool[] {
  const live = async () => {
    const current = await readReviewedFeedCollaboration(context.actor, loadContext)
    if (!current.copy || current.copy.revision !== context.reference.revision) throw new FeedCollaborationError(409, 'draft_context_changed')
    if (context.reference.threadId && !current.threads.some(t => t.id === context.reference.threadId)) throw new FeedCollaborationError(403, 'thread_scope_mismatch')
    return current
  }
  const common = { requiresCapability: 'feed', homeAppToolSet: { app: 'feed' as const, set: 'write' as const }, isConcurrencySafe: false, timeoutMs: 15_000 }
  return [
    buildTool({ ...common, name: 'previewLinkedInFeed', description: 'Read the exact converted LinkedIn payload, ordered image hashes and preview hash for the selected draft revision. This does not approve or publish.', inputSchema: z.object({}).strict(), isReadOnly: true, requiresConfirmation: false,
      async execute() { await live(); return { data: await readLinkedInPreview(context.actor, context.reference.revision) } } }),
    buildTool({ ...common, name: 'selectFeedSources', description: 'Select exact memories for this draft. All collaborators must be authorized. This does not change source sensitivity, ambient access, or authorize public release.', inputSchema: z.object({ mutationId: z.string().uuid(), memoryIds: z.array(z.string().uuid()).max(100) }).strict(), isReadOnly: false, requiresConfirmation: true,
      async execute(input) { await live(); return { data: await feedCommand({ ...context.actor, kind: 'user' }, { mutationId: input.mutationId, expectedRevision: context.reference.revision, commands: [{ kind: 'context', selectedMemoryIds: input.memoryIds }] }) } } }),
    buildTool({ ...common, name: 'authorizeFeedPublicRelease', description: 'After the member reviews final text and attachments, authorize this exact revision for Public release. This does not publish or release private references, discussion, other versions, or customer records.', inputSchema: z.object({ mutationId: z.string().uuid() }).strict(), isReadOnly: false, requiresConfirmation: true,
      async execute(input) { await live(); if (context.reference.target && context.reference.target.kind !== 'post') throw new FeedCollaborationError(403, 'selection_scope_mismatch'); return { data: await feedCommand({ ...context.actor, kind: 'user' }, { mutationId: input.mutationId, expectedRevision: context.reference.revision, commands: [{ kind: 'release', audience: 'public' }] }) } } }),

    buildTool({ ...common, name: 'readFeedLearning', description: 'Inspect authorized post confirmations, decision summaries, learned rules/voice, source decisions, scope and synthesis status. Private lessons unavailable to this shared Feed context are omitted with an access-limit flag. Reading never creates a rule or confirms a post.', inputSchema: z.object({}).strict(), isReadOnly: true, requiresConfirmation: false,
      async execute() { await live(); return { data: await readFeedLearnedDecisions(context.actor) } } }),
    ...(feedLinkedInPublisher() ? [buildTool({...common,name:'publishLinkedInFeed',description:'Publish this whole approved draft through Cloud Link after explicit publication consent. Requires the exact preview hash, editorial confirmation, and public release. An ambiguous result requires checking LinkedIn before retrying.',inputSchema:z.object({expectedRevision:z.number().int().nonnegative(),previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),isReadOnly:false,requiresConfirmation:true,async execute(input){await live();if(input.expectedRevision!==context.reference.revision||context.reference.target&&context.reference.target.kind!=='post')throw new FeedCollaborationError(403,'selection_scope_mismatch');return {data:await feedLinkedInPublisher()!({...context.actor,kind:'user'},input.previewHash)}}})] : []),
    buildTool({...common,name:'createLinkedInPromotion',description:'Only when explicitly requested after manual edition publication, create a separate LinkedIn link-post draft for promotion. LinkedIn may already have made a launch post. This action never publishes; the new draft requires its own review and confirmation.',inputSchema:z.object({sessionId:uuid,expectedRevision:z.number().int().nonnegative()}).strict(),isReadOnly:false,requiresConfirmation:true,async execute(input){await live();if(input.expectedRevision!==context.reference.revision||context.reference.target&&context.reference.target.kind!=='post')throw new FeedCollaborationError(403,'selection_scope_mismatch');return {data:await createLinkedInPromotion({...context.actor,kind:'user'},input.expectedRevision,input.sessionId)}}}),
    buildTool({...common,name:'markLinkedInEditionPublished',description:'After the operator explicitly confirms publishing this exact edition in LinkedIn, record its actual pulse URL and author as an operator-confirmed receipt. Never infer publication from copying, export or opening LinkedIn. Requires exact editorial confirmation and public release.',inputSchema:linkedinManualCommand,isReadOnly:false,requiresConfirmation:true,async execute(input){await live();if(input.expectedRevision!==context.reference.revision||context.reference.target&&context.reference.target.kind!=='post')throw new FeedCollaborationError(403,'selection_scope_mismatch');return {data:await completeLinkedInManual({...context.actor,kind:'user'},input)}}}),
    buildTool({ ...common, name: 'confirmFeedPost', description: 'After explicit final editorial approval, confirm this exact saved whole-post revision and enqueue its bounded decision synthesis. Requires confirmation. This records editorial approval even if subsequent delivery fails; it does not publish the post. Single-suggestion acceptance, Review, copying and saving never authorize this action.', inputSchema: feedConfirmationRequestSchema, isReadOnly: false, requiresConfirmation: true,
      async execute(input) { await live(); if (input.expectedRevision !== context.reference.revision || context.reference.target && context.reference.target.kind !== 'post') throw new FeedCollaborationError(403, 'selection_scope_mismatch'); const result = await confirmFeedPost({ ...context.actor, kind: 'user' }, input); return { data: { confirmationId: result.confirmation.id, revision: result.confirmation.revision, runId: result.runId } } } }),
    buildTool({ ...common, name: 'manageFeedLearning', description: 'Apply an explicitly requested correction, dismissal, forgetting, scope decision, source retraction or confirmation revocation to the selected Feed learning artifact. Remember is direct authority for a scoped future instruction; a post-only exception does not erase the standing rule. Shared voice still requires team governance. Requires confirmation and the exact current draft revision.', inputSchema: feedLearningCommandRequestSchema, isReadOnly: false, requiresConfirmation: true,
      async execute(input) { await live(); if (input.expectedRevision !== context.reference.revision) throw new FeedCollaborationError(409, 'draft_context_changed'); return { data: await executeFeedLearningCommand({ ...context.actor, kind: 'user' }, input) } } }),
    ...(generation ? [
      buildTool({ ...common, name: 'estimateFeedGeneration', description: 'Prepare a cheap estimate for the selected saved text or image slot. Returns the exact brief, source coverage, model, bounded output and server price. Show these to the user before asking for generation confirmation. No model work is dispatched.', inputSchema: feedGenerationEstimateRequestSchema, isReadOnly: false, requiresConfirmation: false,
        async execute(input) { await live(); if (input.expectedRevision !== context.reference.revision) throw new FeedCollaborationError(409, 'draft_context_changed'); const target = context.reference.target; if (target && target.kind !== 'post' && (target.kind !== 'block' || target.blockId !== input.slotId || target.segmentId !== input.segmentId)) throw new FeedCollaborationError(403, 'selection_scope_mismatch'); return { data: await generation.estimate(context.actor, input) } } }),
      buildTool({ ...common, name: 'generateFeedSlot', description: 'After the user confirms the estimate cost and exact output brief, dispatch that server-issued estimate. Requires explicit confirmation. Creates candidates for review; never fills, approves or publishes the slot automatically.', inputSchema: feedGenerationRequestSchema, isReadOnly: false, requiresConfirmation: true,
        async execute(input) { await live(); const estimate = await generation.inspectEstimate(context.actor, input.estimateId); const target = context.reference.target; if (estimate.revision !== context.reference.revision || (target && target.kind !== 'post' && (target.kind !== 'block' || target.blockId !== estimate.slot.id || target.segmentId !== estimate.segmentId))) throw new FeedCollaborationError(403, 'selection_scope_mismatch'); return { data: summarizeFeedRun(await generation.dispatch(context.actor, input)) } } }),
    ] : []),
    buildTool({ ...common, name: 'manageFeedEditorialRun', description: 'Read, cancel or safely retry a draft Review or generation run. Unknown charged outcomes cannot retry; get a new generation estimate and explicit confirmation instead. A saved response repairs without another model call.', inputSchema: z.object({ runId: uuid, action: z.enum(['read', 'cancel', 'retry']) }).strict(), isReadOnly: false, requiresConfirmation: true,
      async execute(input) { await live(); return { data: summarizeFeedRun(await (input.action === 'read' ? getFeedRun : input.action === 'cancel' ? cancelFeedRun : retryFeedRun)(context.actor, input.runId)) } } }),
    buildTool({ ...common, name: 'editFeedPlaceholder', description: 'Apply an explicitly requested operation to a Feed slot: insert at a caret, convert selected notes or a selected fixed image, update its brief/options, fill manually, move, duplicate or remove. In whole-post chat, supply target with the segment and block IDs from the current composition to resume work on a known image or slot without requiring selection again. An attached narrow context still limits the target. A fixed image can only become an image slot; patch can set its initial brief/options in the same edit. Conversion anchors the original image for visual editing; patch.baseImageFileId selects a preferred authorized candidate as the source for the next image generation. Requires confirmation. Uses the same typed edit and history transaction as the editor, and Undo restores the original image. Never starts generation or publication.',
      inputSchema: z.object({ mutationId: uuid, action: z.enum(['insert', 'convert', 'update', 'fillText', 'fillImage', 'moveUp', 'moveDown', 'duplicate', 'remove']), target: z.object({ kind: z.literal('block'), segmentId: uuid, blockId: uuid }).strict().optional(), kind: z.enum(['text', 'image']).optional(), offset: z.number().int().nonnegative().optional(), patch: feedPlaceholderAttrsSchema.omit({ id: true, briefRevision: true }).partial().optional(), text: z.string().min(1).max(100_000).optional(), image: feedMediaSchema.optional() }).strict(), isReadOnly: false, requiresConfirmation: true,
      async execute(input) {
        const current = await live(); const composition = current.copy!.content.composition!; const scope = context.reference.target
        if (input.target && scope && scope.kind !== 'post' && (scope.kind !== 'block' || scope.segmentId !== input.target.segmentId || scope.blockId !== input.target.blockId)) throw new FeedCollaborationError(403, 'selection_scope_mismatch')
        const target = input.target ?? scope ?? { kind: 'post' as const }; let edits: FeedEdit[];
        if (input.action === 'insert' || input.action === 'convert') {
          if (!input.kind || (input.action === 'convert' && target.kind === 'post')) throw new FeedCollaborationError(400, 'placeholder_target_required')
          const caret = input.offset !== undefined && target.kind === 'block' ? { segmentId: target.segmentId, blockId: target.blockId, offset: input.offset } : undefined
          edits = insertFeedPlaceholder(composition, { target, caret }, input.kind, input.action === 'convert', input.action === 'convert' ? input.patch : undefined)
        } else {
          if (target.kind !== 'block') throw new FeedCollaborationError(400, 'placeholder_target_required')
          const found = locateFeedNode(composition, target.segmentId, target.blockId); const node = found.node
          if (node.type !== 'generationPlaceholder') throw new FeedCollaborationError(409, 'generation_slot_required')
          if (input.action === 'update') { if (!input.patch) throw new FeedCollaborationError(400, 'placeholder_patch_required'); edits = [{ kind: 'replaceBlock', segmentId: target.segmentId, blockId: target.blockId, preimage: node, replacement: [{ type: 'generationPlaceholder', attrs: { ...node.attrs, ...input.patch, briefRevision: node.attrs.briefRevision + 1 } }] }] }
          else if (input.action === 'fillText') { if (node.attrs.kind !== 'text' || !input.text) throw new FeedCollaborationError(400, 'text_fill_required'); edits = proposeFeedReplacement(composition, target, input.text) }
          else if (input.action === 'fillImage') { if (node.attrs.kind !== 'image' || !input.image) throw new FeedCollaborationError(400, 'image_fill_required'); edits = [{ kind: 'replaceBlock', segmentId: target.segmentId, blockId: target.blockId, preimage: node, replacement: [{ type: 'image', attrs: { ...input.image, id: node.attrs.id, placement: current.copy!.content.postFormat === 'article' ? 'inline' : 'attachment' } }] }] }
          else if (input.action === 'duplicate') edits = [{ kind: 'insertBlock', segmentId: target.segmentId, parentId: found.parentId, afterId: target.blockId, node: duplicateFeedNode(node) }]
          else if (input.action === 'remove') edits = [...(found.siblings.length === 1 ? [{ kind: 'insertBlock' as const, segmentId: target.segmentId, parentId: found.parentId, afterId: target.blockId, node: feedParagraph('') }] : []), { kind: 'replaceBlock', segmentId: target.segmentId, blockId: target.blockId, preimage: node, replacement: [] }]
          else { const up = input.action === 'moveUp'; if ((up && found.index === 0) || (!up && found.index === found.siblings.length - 1)) throw new FeedCollaborationError(409, 'placeholder_at_boundary'); edits = [{ kind: 'moveBlock', segmentId: target.segmentId, blockId: target.blockId, parentId: found.parentId, afterId: up ? found.siblings[found.index - 2]?.attrs.id ?? null : found.siblings[found.index + 1]!.attrs.id }] }
        }
        return { data: await feedCommand({ ...context.actor, kind: 'user' }, { mutationId: input.mutationId, expectedRevision: context.reference.revision, commands: [{ kind: 'edit', edits, reasonThreadId: context.reference.threadId, applicationId: context.applicationId }] }) }
      } }),
    buildTool({ ...common, name: 'reviewFeedDraft', description: 'Request five bounded editorial checks for the current Feed draft. Results appear as comments with source coverage. This does not edit, approve, publish, change Goals or save memory. Reuse mutationId to check the same request; an uncertain call requires an explicit new attempt.', inputSchema: feedReviewRequestSchema, isReadOnly: false, requiresConfirmation: false,
      async execute(input) { await live(); if (input.expectedRevision !== context.reference.revision) throw new FeedCollaborationError(409, 'draft_context_changed'); return { data: summarizeFeedRun(await requestFeedReview(context.actor, input, loadContext)) } } }),
    buildTool({ ...common, name: 'readFeedDraft', description: 'Read the current authorized composition, comments and suggestions for this Feed draft. Returns its exact content revision.', inputSchema: z.object({}).strict(), isReadOnly: true, requiresConfirmation: false,
      async execute() { return { data: await live() } } }),
    buildTool({ ...common, name: 'commentOnFeedDraft', description: 'Discuss the selected Feed passage or block without changing copy. In a thread, reply in that same thread. Ordinary comments do not generate images or authorize rewriting.',
      inputSchema: z.object({ mutationId: uuid, text: z.string().trim().min(1).max(20_000), target: feedTargetSchema.optional() }).strict(), isReadOnly: false, requiresConfirmation: false,
      async execute(input) {
        await live(); const threadId = context.reference.threadId
        const target = context.reference.target ?? input.target ?? { kind: 'post' as const }
        const receipt = await feedCommand(context.actor, { mutationId: input.mutationId, expectedRevision: context.reference.revision, commands: [threadId ? { kind: 'reply', threadId, text: input.text } : { kind: 'comment', threadId: input.mutationId, target, text: input.text }] })
        return { data: receipt }
      } }),
    buildTool({ ...common, name: 'suggestFeedDraftChange', description: 'Propose exact selected-passage changes for human review. Preserve unselected content. Supply exact inline preimages from readFeedDraft. This creates a suggestion and does not apply it.',
      inputSchema: z.object({ mutationId: uuid, edits: z.array(feedEditSchema).min(1).max(100), rationale: z.string().max(20_000), parentId: uuid.optional() }).strict(), isReadOnly: false, requiresConfirmation: false,
      async execute(input) {
        await live(); selectedEdits(context, input.edits)
        return { data: await feedCommand(context.actor, { mutationId: input.mutationId, expectedRevision: context.reference.revision, commands: [{ kind: 'propose', suggestionId: input.mutationId, edits: input.edits, rationale: input.rationale, parentId: input.parentId, threadId: context.reference.threadId, sourceMessageId, applicationId: context.applicationId }] }) }
      } }),
    buildTool({ ...common, name: 'applyFeedDraftCommands', description: 'Apply explicitly approved Feed edits, suggestion decisions, Undo or context changes through the canonical command service. Requires confirmation. Discussion alone is not approval. Does not approve or publish a post.',
      inputSchema: feedCommandRequestSchema, isReadOnly: false, requiresConfirmation: true,
      async execute(input) {
        const current = await live()
        for (const command of input.commands) {
          if (command.kind === 'linkedin' && context.reference.target && context.reference.target.kind !== 'post') throw new FeedCollaborationError(403, 'selection_scope_mismatch')
          if (command.kind === 'release') throw new FeedCollaborationError(403, 'dedicated_release_required')
          if (command.kind === 'edit' || command.kind === 'propose') selectedEdits(context, command.edits)
          if (command.kind === 'decide') { const suggestion = current.suggestions.find(s => s.id === command.suggestionId); if (!suggestion) throw new FeedCollaborationError(404, 'suggestion_not_found'); selectedEdits(context, suggestion.edits) }
          if (context.reference.target?.kind === 'range' && ['undo', 'context', 'upgrade', 'linkedin'].includes(command.kind)) throw new FeedCollaborationError(403, 'selection_scope_mismatch')
        }
        return { data: await feedCommand({ ...context.actor, kind: 'user' }, { ...input, commands: input.commands.map(command => command.kind === 'edit' || command.kind === 'propose' ? { ...command, applicationId: context.applicationId } : command) }) }
      } }),
    // Whole alternatives remain available; every invocation, even a reused
    // cardboard index, receives its own immutable proposal identity.
    buildProposeDraftsTool({ capture: async input => {
      const current = await live(); const content = current.copy!.content.composition!
      const mutationId = randomUUID()
      const commands = input.drafts.map(draft => {
        const target = context.reference.target ?? { kind: 'post' as const }
        if (target.kind === 'post' && content.segments.length > 1 && draft.threadSegments?.length !== content.segments.length) throw new FeedCollaborationError(400, 'matching_thread_segments_required')
        const edits = target.kind === 'post' && draft.threadSegments ? content.segments.flatMap((segment, index) => proposeFeedReplacement({ version: 1, segments: [segment] }, target, draft.threadSegments![index]!)) : proposeFeedReplacement(content, target, draft.text)
        // A whole alternative is explicitly post-scoped; it is still only a
        // proposal. A selected rewrite uses suggestFeedDraftChange instead.
        return { kind: 'propose' as const, suggestionId: randomUUID(), edits, rationale: input.rationale, sourceProposal: draft, sourceMessageId, applicationId: context.applicationId, sourceToolCallId: `${mutationId}:${draft.index}`, ...(context.reference.threadId ? { threadId: context.reference.threadId } : {}) }
      })
      return feedCommand(context.actor, { mutationId, expectedRevision: current.copy!.revision, commands })
    } }),
  ]
}
