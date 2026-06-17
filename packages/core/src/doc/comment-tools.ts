/**
 * Doc comments — the two AI-facing tools.
 *
 *   - `postComment`     — start or append to a block-anchored comment thread.
 *                         The render-first loop (see soul.ts) calls this to
 *                         annotate uncertainties instead of blocking the draft.
 *   - `resolveComment`  — mark a thread resolved once its question is answered.
 *   - `getCommentThread`— read one thread's full conversation on demand (the
 *                         "details" half of in-page thread discovery; the index
 *                         is injected into the prompt, see comment-discovery.ts).
 *
 * An AI comment is a PURE DB write: it never touches the Yjs doc (the AI is
 * block-anchored; the highlight is a client decoration from `anchorBlockId`).
 * Both tools are `isConcurrencySafe: false` — each `postComment` mints a
 * session + thread row, so the executor must serialize a fan-out rather than
 * race the connection pool and the session unique key.
 *
 * Fan-out: one instruction → N `postComment` tool_use blocks in a single
 * turn → N `comment_posted` results, each streamed by the chat route as its
 * own SSE event the editor paints as a separate badge.
 *
 * Spec: `docs/architecture/features/doc-comments.md`.
 *
 * [COMP:doc/comment-tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { CommentThreadStore } from './comment-types.js'

export type CommentToolDeps = {
  commentThreadStore: CommentThreadStore
}

/** Normalize a comment body for the cheap duplicate-fan-out guard. */
function normalizeBody(body: string): string {
  return body.trim().replace(/\s+/g, ' ').toLowerCase()
}

const postCommentInputSchema = z.object({
  pageId: z.string().min(1).describe('The doc page the thread is on.'),
  threadId: z
    .string()
    .optional()
    .describe(
      "Omit (or pass 'new') to START a thread anchored to `anchorBlockId`; pass an existing thread id to APPEND a reply.",
    ),
  anchorBlockId: z
    .string()
    .optional()
    .describe(
      'When starting a thread, the id of the block this comment is about (from the page outline). The block gets a highlight + gutter badge.',
    ),
  quote: z
    .string()
    .max(280)
    .optional()
    .describe('Optional short snapshot of the anchored text, shown in the comment header.'),
  body: z.string().min(1).describe('The comment text.'),
})

const resolveCommentInputSchema = z.object({
  threadId: z.string().min(1).describe('The thread to mark resolved.'),
})

const getCommentThreadInputSchema = z.object({
  threadId: z
    .string()
    .min(1)
    .describe("The thread to read — a thread id from the page's thread-discovery index."),
  pageId: z
    .string()
    .optional()
    .describe('Optional; the thread is resolved by its id, so this is not required.'),
})

const NO_STORE = {
  data: 'Comments are not available in this context.',
  isError: true as const,
}

const NO_WORKSPACE = {
  data: 'Doc comments require a workspace-scoped assistant.',
  isError: true as const,
}

export function createPostCommentTool(deps: CommentToolDeps): Tool {
  return buildTool({
    name: 'postComment',
    description:
      'Post a comment to a doc page as a block-anchored thread. ' +
      'Use this to ask a clarifying question or flag a decision IN CONTEXT instead of blocking the draft — render your best version first, then drop uncertainties as comments pinned to the blocks they concern. ' +
      'Start a new thread by passing `anchorBlockId` (and omitting `threadId`); reply in an existing thread by passing its `threadId`. ' +
      'You can post several comments on different blocks in one turn.',
    inputSchema: postCommentInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 15_000,

    async execute(input, context) {
      if (!deps.commentThreadStore) return NO_STORE
      if (!context.workspaceId) return NO_WORKSPACE
      const store = deps.commentThreadStore

      // Append to an existing thread.
      if (input.threadId && input.threadId !== 'new') {
        const existing = await store.getThread(context.userId, input.threadId)
        if (!existing) {
          return { data: `Thread not found: ${input.threadId}.`, isError: true }
        }
        await store.addComment({
          userId: context.userId,
          threadId: input.threadId,
          role: 'assistant',
          body: input.body,
        })
        return {
          data: {
            kind: 'comment_posted' as const,
            threadId: input.threadId,
            pageId: existing.pageId,
            anchorBlockId: existing.anchorBlockId,
            isNew: false,
          },
        }
      }

      // Start a new thread. Cheap guard against re-posting a near-identical
      // comment on the same block (keeps the loop-detector from blocking a
      // legitimate fan-out, and avoids duplicate badges on retries).
      const open = await store.listThreadsForPage(context.userId, input.pageId)
      const dup = open.find(
        (t) =>
          t.anchorKind === 'ai_block' &&
          t.anchorBlockId === (input.anchorBlockId ?? null) &&
          normalizeBody(t.quote ?? '') === normalizeBody(input.quote ?? ''),
      )
      if (dup) {
        return {
          data: {
            kind: 'comment_posted' as const,
            threadId: dup.id,
            pageId: dup.pageId,
            anchorBlockId: dup.anchorBlockId,
            isNew: false,
          },
        }
      }

      const thread = await store.createThread({
        userId: context.userId,
        workspaceId: context.workspaceId,
        pageId: input.pageId,
        assistantId: context.assistantId,
        anchorKind: 'ai_block',
        anchorBlockId: input.anchorBlockId ?? null,
        quote: input.quote ?? null,
        firstComment: { role: 'assistant', body: input.body },
      })
      return {
        data: {
          kind: 'comment_posted' as const,
          threadId: thread.id,
          pageId: thread.pageId,
          anchorBlockId: thread.anchorBlockId,
          isNew: true,
        },
      }
    },
  })
}

export function createResolveCommentTool(deps: CommentToolDeps): Tool {
  return buildTool({
    name: 'resolveComment',
    description:
      'Mark a doc comment thread resolved once its question has been answered or its change made. ' +
      'Resolved threads are archived (not deleted) and drop off the page gutter.',
    inputSchema: resolveCommentInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    timeoutMs: 10_000,

    async execute(input, context) {
      if (!deps.commentThreadStore) return NO_STORE
      const updated = await deps.commentThreadStore.setResolved({
        userId: context.userId,
        threadId: input.threadId,
        resolved: true,
      })
      if (!updated) {
        return { data: `Thread not found: ${input.threadId}.`, isError: true }
      }
      return { data: { kind: 'thread_resolved' as const, threadId: input.threadId } }
    },
  })
}

export function createGetCommentThreadTool(deps: CommentToolDeps): Tool {
  return buildTool({
    name: 'getCommentThread',
    description:
      "Read one doc comment thread end-to-end: its anchor plus every comment in order. " +
      "Use it to pull the conversation behind a thread listed in the page's thread index when " +
      'that thread is relevant to what you are doing — the index shows only metadata, this returns ' +
      'the actual messages. Read before answering a question a thread may already cover.',
    inputSchema: getCommentThreadInputSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input, context) {
      if (!deps.commentThreadStore) return NO_STORE
      const store = deps.commentThreadStore

      const thread = await store.getThread(context.userId, input.threadId)
      if (!thread) {
        return { data: `Thread not found or not accessible: ${input.threadId}.`, isError: true }
      }
      const messages = (await store.listThreadComments(context.userId, input.threadId)) ?? []

      return {
        data: {
          kind: 'comment_thread' as const,
          threadId: thread.id,
          pageId: thread.pageId,
          anchorKind: thread.anchorKind,
          anchorBlockId: thread.anchorBlockId,
          quote: thread.quote,
          resolved: thread.resolvedAt != null,
          messages: messages.map((m) => ({
            role: m.role,
            body: m.body,
            createdAt: m.createdAt,
          })),
        },
      }
    },
  })
}
