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

// Page templates — re-exported from core's `dist/doc/templates.js` leaf, which
// imports only the fs-free `markdown.js` + `blocks.js` leaves (no barrel, no
// `skills/loader`/`fs`), so the browser editor's "/template" gallery
// (`apps/app-web` `template-gallery.tsx`) can list + instantiate templates
// without pulling the core barrel. Same source of truth the brain-MCP
// `listPageTemplates` / `createPageFromTemplate` tools read.
// See docs/architecture/features/doc-templates.md.
export {
  type PageTemplate,
  type PageTemplateSummary,
  type PageTemplateCategory,
  type InstantiatedTemplate,
  type TemplateVars,
  PAGE_TEMPLATES,
  listPageTemplates,
  getPageTemplate,
  pageTemplateIds,
  instantiatePageTemplate,
} from '@sidanclaw/core/dist/doc/templates.js'

// Custom (user-authored, workspace-shared) page templates — re-exported from
// core's fs-free `dist/doc/custom-template-types.js` leaf (imports only `zod`
// + the `blocks.js` schema leaf). The gallery / editor consume the types +
// `withFreshBlockIds` (mints fresh ids when a stored-blocks template is
// inserted/seeded). See docs/architecture/features/doc-templates.md ->
// "Custom templates".
export {
  type CustomPageTemplate,
  type CustomPageTemplateSummary,
  type CustomTemplateCreateInput,
  type ExtractionSpec,
  type ExtractionSection,
  type ExtractionField,
  type ExtractionFieldType,
  type BlueprintCaptureKind,
  type EntityRefKind,
  PAGE_TEMPLATE_CATEGORIES,
  EXTRACTION_FIELD_TYPES,
  BLUEPRINT_CAPTURE_KINDS,
  ENTITY_REF_KINDS,
  pageTemplateCategorySchema,
  customTemplateCreateInputSchema,
  extractionSpecSchema,
  normalizeExtractionSpec,
  fieldKeyFromHeading,
  withFreshBlockIds,
  // Derives a blueprint's `extraction` spec from authored blocks (each
  // extraction_slot paired with its preceding heading). The editor's
  // "Save as template" path calls this so a WYSIWYG blueprint persists as a
  // blueprint (extraction != null) instead of a plain skeleton.
  blocksToExtractionSpec,
} from '@sidanclaw/core/dist/doc/custom-template-types.js'

// Starter blueprints — the installable catalog, from the same fs-free leaf
// discipline (it imports only `custom-template-types.js` + the `blocks.js`
// types). The client needs it because INSTALL is a normal template create: the
// blocks + derived spec POST to the existing route, minting a row the workspace
// owns. See structural-synthesis.md -> "Starter blueprints".
export {
  type StarterBlueprint,
  MEETING_NOTES_STARTER,
  STARTER_BLUEPRINTS,
  findStarterBlueprint,
  starterExtractionSpec,
} from '@sidanclaw/core/dist/doc/starter-blueprints.js'

// Blueprint record helpers — the typed output contract's pure half (field
// validation, completeness, page projection). Same fs-free leaf discipline.
export {
  type BlueprintRecordFields,
  type BlueprintRecordStatus,
  type BlueprintEntityRefValue,
  validateFieldValue,
  recordCompleteness,
  formatFieldValueText,
  blueprintRecordToBlocks,
} from '@sidanclaw/core/dist/doc/blueprint-record.js'

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
