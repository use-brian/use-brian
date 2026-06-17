/**
 * @sidanclaw/doc-model — the single source of truth for a doc page's
 * collaborative document shape (Tiptap/ProseMirror schema + block↔node
 * mapping + Y.Doc encode/decode). Shared by the browser editor, the Yjs sync
 * server, the server-side AI client, and the block→Y.Doc migration.
 *
 * Its only `@sidanclaw/core` *runtime* dependency is the fs-free
 * `markdownToBlocks` leaf (`dist/doc/markdown.js` — pure regex, no
 * `skills/loader`/`fs`); everything else imports core as types only, via the
 * deep `dist` path. This keeps the browser bundle free of `skills/loader`'s
 * `fs` dependency.
 */

export {
  FRAGMENT_FIELD,
  META_MAP,
  Callout,
  Toggle,
  Embed,
  DocAttrs,
  docExtensions,
  docSchema,
} from './schema.js'

export {
  type PMNode,
  type PMDoc,
  blockToNode,
  blocksToPMDoc,
  nodeToBlock,
  pmDocToBlocks,
  canonicalizeBlock,
  canonicalizePage,
  pageToPlaintext,
} from './block-mapping.js'

// The faithful Markdown importer, re-exported from core's fs-free
// `dist/doc/markdown.js` leaf (see the header note) so the browser editor's
// paste handler (`apps/app-web` `markdown-paste.ts`, journey E of
// docs/architecture/features/doc-conversion.md) can convert Markdown → blocks
// without pulling the core barrel.
export { markdownToBlocks } from '@sidanclaw/core/dist/doc/markdown.js'

export {
  pageToYDoc,
  pageToYDocUpdate,
  yDocToSnapshot,
  yDocFromUpdate,
  snapshotFromUpdate,
  yDocToPlaintext,
} from './encode.js'

export {
  type DocOp,
  type ApplyOpsResult,
  applyOpsToYDoc,
  healBlockIds,
} from './apply-ops.js'

export {
  type AssistantRunChannel,
  type AssistantRunStep,
  type AssistantRunState,
  ASSISTANT_RUN_TTL_MS,
  deriveRunStep,
  deriveRunBlockId,
} from './run-presence.js'
