/**
 * Page templates — Notion-style starter layouts for the doc editor.
 *
 * A template is metadata plus a Markdown `body`. Instantiating one runs the
 * body through the SAME Markdown -> blocks path `createPage` / `editPage`
 * use (`markdownToBlocks` + `normalizeMarkdownBlocks`), so a template-seeded
 * page is identical in shape to a hand-authored one and every block gets a
 * fresh id on each instantiation. The body may use the structured Markdown
 * forms the importer understands: headings (`#`), bulleted / numbered lists,
 * checkboxes (`- [ ]`), block quotes (`>`), GFM alerts (`> [!NOTE]`) which
 * import as callouts, GFM tables, `<details>` disclosures which import as
 * toggles, fenced code, and `---` dividers.
 *
 * Bodies and titles may carry `{{var}}` placeholders (e.g. `{{date}}`,
 * `{{dateLong}}`, `{{week}}`). They are resolved at instantiation against a
 * caller-supplied `now` (defaulted to the current time) so the same template
 * yields a dated page without the registry knowing the clock — which keeps
 * the catalog a pure constant and the substitution unit-testable.
 *
 * This registry is the single source of truth shared by the editor slash
 * menu (insert at the cursor) and the brain-MCP tools (`listPageTemplates` /
 * `createPageFromTemplate`). Adding a template here surfaces it in both.
 *
 * See docs/architecture/features/doc-templates.md.
 * [COMP:doc/templates]
 */

import type { Block } from '../views/blocks.js'
import { markdownToBlocks, normalizeMarkdownBlocks } from './markdown.js'

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Gallery grouping for a template. Mirrors the way Notion's template picker
 * shelves starters by intent rather than by block kind.
 */
export type PageTemplateCategory =
  | 'meeting'
  | 'planning'
  | 'personal'
  | 'knowledge'
  | 'team'

/** A page template definition — pure metadata plus a Markdown body. */
export type PageTemplate = {
  /** Stable kebab-case id — the handle the MCP tools and slash menu pass. */
  id: string
  /** Display name shown in the gallery / slash menu. */
  name: string
  /** One-line description for the gallery row. */
  description: string
  /** Emoji glyph; seeds `saved_views.icon` on a template-created page. */
  icon: string
  /** Gallery grouping. */
  category: PageTemplateCategory
  /** Fuzzy-match tokens for the slash menu (lowercase). */
  keywords: string[]
  /** Suggested page title; may contain `{{var}}` placeholders. */
  titleTemplate: string
  /** Markdown body; may contain `{{var}}` placeholders. */
  body: string
}

/**
 * The catalog row returned to a caller that only needs to render / pick a
 * template (the slash menu, the `listPageTemplates` MCP tool). It omits the
 * heavy `body` so a list call stays compact.
 */
export type PageTemplateSummary = Omit<PageTemplate, 'body'>

/** Placeholder values substituted into a template's title + body. */
export type TemplateVars = Record<string, string>

/** A resolved template, ready to seed a page or insert at the cursor. */
export type InstantiatedTemplate = {
  /** The source template id. */
  templateId: string
  /** Resolved title (placeholders substituted). */
  title: string
  /** Emoji glyph to seed the page icon. */
  icon: string
  /** Canonical blocks with fresh ids. */
  blocks: Block[]
}

// ── Variable substitution ─────────────────────────────────────────────

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * ISO-8601 week number for `date` (UTC). Week 1 is the week containing the
 * first Thursday of the year; weeks start Monday. Pure over the input date.
 */
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  // Thursday in the current week decides the year.
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/**
 * The default placeholder set derived from `now` (UTC). Callers may override
 * or extend any key via the `vars` instantiation option. Dates use UTC so the
 * mapping is deterministic and matches the project's UTC-timestamp convention.
 */
export function defaultTemplateVars(now: Date): TemplateVars {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const d = now.getUTCDate()
  return {
    date: `${y}-${pad2(m + 1)}-${pad2(d)}`,
    dateLong: `${MONTHS[m]} ${d}, ${y}`,
    weekday: WEEKDAYS[now.getUTCDay()],
    month: MONTHS[m],
    year: String(y),
    week: `${y}-W${pad2(isoWeekNumber(now))}`,
  }
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

/**
 * Replace `{{key}}` placeholders in `src` from `vars`. An unknown key is left
 * verbatim so a stray placeholder is visible (and fixable) rather than
 * silently dropped.
 */
export function applyTemplateVars(src: string, vars: TemplateVars): string {
  return src.replace(PLACEHOLDER_RE, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole,
  )
}

// ── Registry ──────────────────────────────────────────────────────────
//
// Each body is plain Markdown in the structured forms the importer
// recognizes (see the file header). Keep copy hyphen-only — no em dashes —
// since a template's blocks become user-facing page content.

export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    description: 'Agenda, discussion, decisions, and action items for a meeting.',
    icon: '📝',
    category: 'meeting',
    keywords: ['meeting', 'notes', 'agenda', 'minutes', 'sync'],
    titleTemplate: 'Meeting notes - {{date}}',
    body: [
      '# Meeting notes',
      '',
      '> [!NOTE]',
      '> Date: {{dateLong}} | Attendees: ',
      '',
      '## Agenda',
      '',
      '- ',
      '- ',
      '',
      '## Discussion',
      '',
      '- ',
      '',
      '## Decisions',
      '',
      '- ',
      '',
      '## Action items',
      '',
      '- [ ] ',
      '- [ ] ',
      '',
    ].join('\n'),
  },
  {
    id: 'one-on-one',
    name: '1:1 meeting',
    description: 'Recurring one-on-one: wins, blockers, feedback, and follow-ups.',
    icon: '🤝',
    category: 'meeting',
    keywords: ['1:1', 'one on one', 'check-in', 'manager', 'report'],
    titleTemplate: '1:1 - {{date}}',
    body: [
      '# 1:1 - {{dateLong}}',
      '',
      '## Wins since last time',
      '',
      '- ',
      '',
      '## Blockers and concerns',
      '',
      '- ',
      '',
      '## Feedback (both directions)',
      '',
      '- ',
      '',
      '## Action items',
      '',
      '- [ ] ',
      '',
    ].join('\n'),
  },
  {
    id: 'standup',
    name: 'Daily standup',
    description: 'Yesterday, today, and blockers for a quick daily check-in.',
    icon: '☀️',
    category: 'team',
    keywords: ['standup', 'daily', 'scrum', 'status'],
    titleTemplate: 'Standup - {{date}}',
    body: [
      '# Standup - {{dateLong}}',
      '',
      '## Yesterday',
      '',
      '- ',
      '',
      '## Today',
      '',
      '- ',
      '',
      '## Blockers',
      '',
      '- ',
      '',
    ].join('\n'),
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    description: 'Reflect on the week: wins, lessons, metrics, and next week.',
    icon: '🗓️',
    category: 'personal',
    keywords: ['weekly', 'review', 'reflection', 'planning', 'retro'],
    titleTemplate: 'Weekly review - {{week}}',
    body: [
      '# Weekly review - {{week}}',
      '',
      '> [!TIP]',
      '> Week of {{dateLong}}',
      '',
      '## Highlights',
      '',
      '- ',
      '',
      '## What went well',
      '',
      '- ',
      '',
      '## What to improve',
      '',
      '- ',
      '',
      '## Metrics',
      '',
      '| Metric | Target | Actual |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '',
      '## Focus for next week',
      '',
      '- [ ] ',
      '',
    ].join('\n'),
  },
  {
    id: 'daily-journal',
    name: 'Daily journal',
    description: 'A dated journal entry with gratitude, focus, and notes.',
    icon: '📔',
    category: 'personal',
    keywords: ['journal', 'diary', 'daily', 'log', 'reflection'],
    titleTemplate: '{{dateLong}}',
    body: [
      '# {{weekday}}, {{dateLong}}',
      '',
      '## Top 3 priorities',
      '',
      '- [ ] ',
      '- [ ] ',
      '- [ ] ',
      '',
      '## Grateful for',
      '',
      '- ',
      '',
      '## Notes',
      '',
      '- ',
      '',
    ].join('\n'),
  },
  {
    id: 'project-plan',
    name: 'Project plan',
    description: 'Goal, scope, milestones, risks, and a task checklist.',
    icon: '🚀',
    category: 'planning',
    keywords: ['project', 'plan', 'roadmap', 'milestones', 'scope'],
    titleTemplate: 'Project plan',
    body: [
      '# Project plan',
      '',
      '> [!IMPORTANT]',
      '> Owner:  | Target date:  | Status: Not started',
      '',
      '## Goal',
      '',
      'What does success look like?',
      '',
      '## Scope',
      '',
      '### In scope',
      '',
      '- ',
      '',
      '### Out of scope',
      '',
      '- ',
      '',
      '## Milestones',
      '',
      '| Milestone | Owner | Due |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '',
      '## Risks',
      '',
      '- ',
      '',
      '## Tasks',
      '',
      '- [ ] ',
      '- [ ] ',
      '',
    ].join('\n'),
  },
  {
    id: 'product-brief',
    name: 'Product brief',
    description: 'A lightweight PRD: problem, users, solution, and success metrics.',
    icon: '📦',
    category: 'planning',
    keywords: ['product', 'brief', 'prd', 'spec', 'requirements'],
    titleTemplate: 'Product brief',
    body: [
      '# Product brief',
      '',
      '## Problem',
      '',
      'What problem are we solving, and for whom?',
      '',
      '## Target users',
      '',
      '- ',
      '',
      '## Proposed solution',
      '',
      '- ',
      '',
      '## Out of scope',
      '',
      '- ',
      '',
      '## Success metrics',
      '',
      '| Metric | Baseline | Target |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '',
      '## Open questions',
      '',
      '<details><summary>Questions to resolve</summary>',
      '',
      '- ',
      '',
      '</details>',
      '',
    ].join('\n'),
  },
  {
    id: 'okrs',
    name: 'OKRs',
    description: 'Objectives and measurable key results for a quarter.',
    icon: '🎯',
    category: 'planning',
    keywords: ['okr', 'objectives', 'key results', 'goals', 'quarter'],
    titleTemplate: 'OKRs - {{year}}',
    body: [
      '# OKRs - {{year}}',
      '',
      '## Objective 1',
      '',
      'A qualitative, inspiring goal.',
      '',
      '- [ ] Key result: ',
      '- [ ] Key result: ',
      '- [ ] Key result: ',
      '',
      '## Objective 2',
      '',
      'A qualitative, inspiring goal.',
      '',
      '- [ ] Key result: ',
      '- [ ] Key result: ',
      '',
    ].join('\n'),
  },
  {
    id: 'retrospective',
    name: 'Retrospective',
    description: 'Team retro: what went well, what did not, and action items.',
    icon: '🔁',
    category: 'team',
    keywords: ['retro', 'retrospective', 'postmortem', 'review', 'team'],
    titleTemplate: 'Retrospective - {{date}}',
    body: [
      '# Retrospective - {{dateLong}}',
      '',
      '## What went well',
      '',
      '- ',
      '',
      '## What did not go well',
      '',
      '- ',
      '',
      '## What we will try next',
      '',
      '- ',
      '',
      '## Action items',
      '',
      '- [ ] ',
      '',
    ].join('\n'),
  },
  {
    id: 'reading-list',
    name: 'Reading list',
    description: 'Track books and articles with status and notes.',
    icon: '📚',
    category: 'knowledge',
    keywords: ['reading', 'books', 'articles', 'list', 'library'],
    titleTemplate: 'Reading list',
    body: [
      '# Reading list',
      '',
      '| Title | Author | Status | Notes |',
      '| --- | --- | --- | --- |',
      '|  |  | To read |  |',
      '|  |  | Reading |  |',
      '|  |  | Done |  |',
      '',
      '## Highlights',
      '',
      '- ',
      '',
    ].join('\n'),
  },
] as const

// ── Accessors ─────────────────────────────────────────────────────────

const TEMPLATES_BY_ID: ReadonlyMap<string, PageTemplate> = new Map(
  PAGE_TEMPLATES.map((t) => [t.id, t]),
)

/** All template ids the catalog exposes. */
export function pageTemplateIds(): string[] {
  return PAGE_TEMPLATES.map((t) => t.id)
}

/** The full template by id, or `undefined` if no such template. */
export function getPageTemplate(id: string): PageTemplate | undefined {
  return TEMPLATES_BY_ID.get(id)
}

/**
 * The gallery catalog (no bodies) for the slash menu and `listPageTemplates`.
 * Optionally filtered to one `category`.
 */
export function listPageTemplates(category?: PageTemplateCategory): PageTemplateSummary[] {
  const rows = category ? PAGE_TEMPLATES.filter((t) => t.category === category) : PAGE_TEMPLATES
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return rows.map(({ body: _body, ...summary }) => summary)
}

/** Options for {@link instantiatePageTemplate}. */
export type InstantiateOptions = {
  /** Clock for `{{date}}`-style placeholders. Defaults to `new Date()`. */
  now?: Date
  /** Extra / override placeholder values, merged over the defaults. */
  vars?: TemplateVars
  /**
   * Replace the resolved title outright (placeholders in it are NOT expanded;
   * pass an already-final string). Used when the caller already has a name.
   */
  titleOverride?: string
  /** Block-id generator; defaults to the Markdown importer's UUID generator. */
  genId?: () => string
}

/**
 * Resolve a template into a titled, icon-bearing block list with fresh ids.
 * Returns `undefined` when `id` is not in the catalog (the caller reports it).
 *
 * The body runs through `markdownToBlocks` + `normalizeMarkdownBlocks` — the
 * exact path `createPage` / `editPage` use — so the output is canonical and
 * the page is born identical to a hand-authored one.
 */
export function instantiatePageTemplate(
  id: string,
  opts: InstantiateOptions = {},
): InstantiatedTemplate | undefined {
  const template = TEMPLATES_BY_ID.get(id)
  if (!template) return undefined

  const vars: TemplateVars = {
    ...defaultTemplateVars(opts.now ?? new Date()),
    ...(opts.vars ?? {}),
  }

  const title =
    opts.titleOverride !== undefined
      ? opts.titleOverride
      : applyTemplateVars(template.titleTemplate, vars)

  const md = applyTemplateVars(template.body, vars)
  const blocks = opts.genId
    ? normalizeMarkdownBlocks(markdownToBlocks(md, { genId: opts.genId }), opts.genId)
    : normalizeMarkdownBlocks(markdownToBlocks(md))

  // Defensive: never hand back an empty page (mirrors createPage's guard).
  if (blocks.length === 0) {
    blocks.push({ kind: 'text', id: (opts.genId ?? (() => 'tpl-empty'))(), text: '' })
  }

  return { templateId: template.id, title, icon: template.icon, blocks }
}
