// Doc v1 — the doc assistant prompt + wire format + page tools.
//
// Wire format (Phase 0): page-types + page-schemas + ops + outline + undo
// Page tools (Phase 1): renderPage / patchPage / getBlock / queryDataBlock / getCurrentPage
//
// See docs/plans/doc-v1-execution.md and
// .claude/plans/snuggly-noodling-tiger.md.

export { buildDocSkillBlock, buildAmbientDocSkillBlock } from './soul.js'
export type {
  BuildDocSkillParams,
  BuildAmbientDocSkillParams,
  AmbientSurface,
  DocPromptMode,
} from './soul.js'

// Phase 0 wire format
export * from './page-types.js'
export * from './page-schemas.js'
export * from './ops.js'
export * from './outline.js'
export * from './undo.js'

// Phase 0 turn-context instrumentation (doc_context_composition).
export * from './context-meter.js'

// Phase 2/3 large-page map: hierarchical section tree + relevance retrieval.
export * from './outline-tree.js'
export * from './page-retrieval.js'

// Format conversion (doc-format-conversion feature): md⇄blocks both
// directions + the shared richText inline walker. The docx writer
// (`./convert/to-docx.js`) and the `.docx` importer (`../files/docx-convert.js`)
// are exported from the package barrel alongside the other node-only files
// helpers.
export * from './markdown.js'
export * from './to-markdown.js'
export * from './rich-text.js'
export * from './convert/to-docx.js'

// Phase 1 chat tools
export * from './tools.js'

// findPage — always-on discovery/read of a doc page by title (the missing
// list-by-title verb every other doc tool assumes you already resolved).
export * from './find-page.js'

// Auto-title — shared title generator + thresholds (migration 218).
export * from './auto-title.js'

// Doc comments (chat-as-threads): store contract + comment tools.
export * from './comment-types.js'
export * from './comment-tools.js'

// Doc Inbox: the sidebar Inbox wire types + notifications store contract.
export * from './inbox-types.js'

// In-page thread discovery: the metadata-only index injected into the prompt.
export * from './comment-discovery.js'

// Observe-then-reconcile guard for the server-side AI Yjs client (Lock #6).
export * from './reconcile.js'
