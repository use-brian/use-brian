/**
 * Public library surface. Consumed by:
 *   - packages/core (sync worker: parseMarkdownFile, resolveWikilink, buildPathIndex, runAllChecks)
 *   - This package's own CLI (commands/lint.ts: walkKbFromFs, runAllChecks, report)
 */

// Parser — high-level (used by sync worker)
export { parseMarkdownFile, normalisePath, extractFirstHeading, fileNameToTitle, extractTags } from './lib/parser.js'

// Frontmatter — low-level (used by lint + anyone needing raw frontmatter)
export { readFrontmatter, isNestedObject, parseYamlSubset } from './lib/frontmatter.js'

// Wikilink resolver — canonical interface (string → string, used by sync worker)
export { buildPathIndex, resolveWikilink } from './lib/wikilink-resolver.js'

// Lint index — rich variant (used by checks + CLI)
export {
  buildLintIndex,
  walkKbFromFs,
  resolveWikilinkToEntry,
  resolveMdLinkToEntry,
  type LintInputEntry,
} from './lib/kb-index.js'

// Lint checks
export { runAllChecks } from './lib/checks.js'

// Reporter (CLI-side)
export { report, type ExitCode, type ReportOptions } from './lib/report.js'

// Types
export type {
  Sensitivity,
  ParsedEntry,
  Wikilink,
  MdLink,
  LintEntry,
  LintIndex,
  Finding,
  Severity,
} from './lib/types.js'
export { SENSITIVITY_VALUES, SENSITIVITY_RANK, isSensitivity } from './lib/types.js'
