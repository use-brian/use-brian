---
name: doc-architect
description: Structural doc shaper — turn loose notes or workflow output into a rich, well-organized canvas page using the right blocks (table / data / callout / toggle / chart) and sub-pages, instead of dumping a markdown wall. Use when the user wants raw content laid out cleanly, or a workflow step lands a pile of text that needs a real container. Reshapes the container only; never rewrites the substance.
license: MIT
compatibility: Designed for Use Brian
metadata:
  author: Use Brian
  category: productivity
  when_to_use: The user hands you loose notes, a transcript, a dump, or a long workflow output and wants it laid out as a real document — "make this a proper doc", "clean up this page", "structure these notes", "organize this into a doc". Skip when the input is already well-structured, when the user is asking you to write or edit the content itself (this skill never changes substance), or when a short chat reply is the right answer instead of a page.
  tags: official
---

# Doc architect

You're handed loose material — pasted notes, a meeting transcript, a research dump, the output of a workflow step — and asked to make it a real document. Your job is to pick the right canvas container for each part and lay it out cleanly, **not** to rewrite, condense, or filter what was said. Structure the container; leave the substance untouched.

The canvas is more than markdown. It has native tables, live data blocks bound to CRM entities, tinted callouts, collapsible toggles, charts, and nested sub-pages. A wall of `bulleted_list_item`s is the failure mode this skill exists to prevent.

## When to use

- The user pastes notes / a transcript / a dump and asks for "a proper doc", "clean this up", "structure these notes".
- A workflow step produced a long block of text that belongs on a page, and you're laying it out.
- An existing page has grown into an unreadable wall and the user asks you to reorganize it.

**Skip** when:

- The input is already well-structured (it has real headings, tables, sections) — don't re-architect for the sake of it.
- The user wants you to *write* or *edit* the content (add ideas, tighten prose, fix facts). That's editorial work; this skill only reshapes the container and must never touch substance.
- A short chat reply answers the request. Not everything needs to become a page.

## Recipe

### 1. Read before you touch

If you're shaping an existing page, read it first so you patch surgically instead of clobbering:

```
getCurrentPage({})
```

For one heading-delimited section, or a single block:

```
getSection({ headingId: '<heading-block-id>' })
getBlock({ blockId: '<block-id>' })
getBlockRange({ fromId: '<id>', toId: '<id>' })
```

If you're starting from a paste with no page yet, skip straight to step 3.

### 2. Plan the structure (don't write yet)

Look at the raw material and decide the *shape* before emitting any block. Map each part of the input to the right container:

- **Narrative / explanation** → `heading` + `text` + `bulleted_list_item` / `numbered_list_item`. The default, but not the only tool.
- **Static structured data, comparisons, matrices** → a `table` block (native cells). A feature comparison, a pros/cons grid, a pricing matrix — these are tables, not nested bullets.
- **Tasks / contacts / deals that should stay live** → a `data` block bound to the CRM entity: `{ kind: 'data', binding: { entity, viewType } }` where `viewType` is `table` or `board` (only those two exist — never invent `kanban` / `list` / `gallery`; `board` is valid only for `tasks` and `deals`, everything else is `table`-only). You never emit the rows — the block resolves live on every read. Use this whenever the content *is* workspace entities, so the page stays current.
- **Asides, warnings, key takeaways** → a `callout` (tinted panel with `richText` and optional nested `children`).
- **Detail that would bury the main thread** → a `toggle` (collapsible, holds `children`). Put the appendix, the raw log, the long quote behind it.
- **Numbers you actually have** → a `chart` block carrying real `data` (points / series / value). Only with real numbers — never an empty chart shell as decoration.
- **Verbatim source text** → `quote`; **commands / config / code** → `code`.

### 3. Render a new page

When there's no page yet, emit the whole structure in one `renderPage` call with a typed `Page`:

```
renderPage({
  page: {
    title: '<page title>',
    blocks: [
      { kind: 'heading', level: 1, text: '<section>' },
      { kind: 'text', text: '<the user\'s own words, unchanged>' },
      { kind: 'table', /* rows for the comparison */ },
      { kind: 'callout', richText: '<the key takeaway, in their words>' },
      { kind: 'toggle', text: '<appendix>', children: [ /* the long raw block */ ] },
    ],
  },
})
```

Pick the container per part; keep the text inside each block exactly as supplied.

### 4. Patch an existing page surgically

When the page already exists, don't re-render it. Use `patchPage` with the smallest `Op[]` that does the job:

```
patchPage({
  ops: [
    { op: 'add', after: '<block-id>', block: { kind: 'table', /* ... */ } },
    { op: 'edit', blockId: '<id>', patch: { /* container change only */ } },
    { op: 'move', blockId: '<id>', after: '<other-id>' },
    { op: 'setTitle', title: '<new title>' },
    { op: 'setIcon', icon: '<emoji>' },
  ],
})
```

`add` takes `after: <BlockId> | 'start' | 'end'`. Reshaping is almost always `add` (new container) + `move` (relocate existing blocks into order) + `delete` (only of empty scaffolding, never of substance).

### 5. Break long or multi-topic output into sub-pages

When the material covers several distinct topics, or one page would run endlessly, split it. Create a child page per topic, then reference each from the parent with a `child_page` block so the parent reads as a clean index:

```
createSubPage({ parentPageId: '<parent-id>', title: '<topic>', blocks: [ /* that topic */ ] })
```

Then on the parent:

```
patchPage({
  ops: [
    { op: 'add', after: 'end', block: { kind: 'child_page', childPageId: '<the-new-sub-page-id>' } },
  ],
})
```

Sub-pages show up indented in the sidebar tree, and the `child_page` block links to them inline. A research dump with five themes becomes a parent index plus five focused sub-pages — not one scroll-forever page.

### 6. Confirm and hand off

Briefly tell the user what you laid out and where ("Organized into a page with a comparison table and three sub-pages for the deep dives"). Brain / canvas writes are reversible, so don't ask permission before structuring — do it, then show them.

When you exported markdown to reshape it elsewhere, `exportPage` / `importToPage` round-trip the page through markdown; reach for them only when a markdown intermediate is genuinely needed, not as the default path.

## What NOT to do

- **Do not** rewrite, condense, summarize, reorder-for-emphasis, or drop any of the user's substance. This skill changes the *container*, never the content. If a sentence was in the input, it's in the output, in their words.
- **Do not** dump everything into `text` and `bulleted_list_item` blocks. That's the markdown wall this skill exists to replace — reach for `table`, `data`, `callout`, `toggle`, `chart` when the content fits them.
- **Do not** emit rows for a `data` block. A `data` block carries only a `binding`; it resolves live. Hand-typing the rows makes a stale snapshot — use a native `table` for that, or bind a `data` block for the live view.
- **Do not** create a `chart` block without real numbers. An empty or invented chart is decoration that lies. No numbers → no chart.
- **Do not** re-render a whole page to make one change — read with `getCurrentPage` / `getSection`, then `patchPage` the minimal ops. Re-rendering destroys block ids and any live bindings on the page.
- **Do not** pile a long, multi-topic document onto one page. Split into `createSubPage` children and index them from the parent with `child_page` blocks.
- **Do not** invoke this skill when the user wants content written or edited — that's a different job. This is layout only.
