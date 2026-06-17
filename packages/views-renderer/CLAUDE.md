# @sidanclaw/views-renderer

Thin React renderer for the **A2UI v0.8** wire format used by Q5 Views
(`docs/architecture/features/views.md` / `docs/plans/company-brain.md` §16).

**Phase 1 (Notion-feel) extension** — `docs/plans/a2ui-notion-feel.md`
adds a **property-type system**: `A2UIColumn` gains an optional `kind`
hint and four typed widgets (`PersonWidget`, `RelationWidget`,
`DateWidget`, `NumberWidget`) join the catalog. The `properties/`
directory holds one module per kind (`{ Cell, Editor, Icon, sortFn }`).
`Table.tsx` and `render.tsx` dispatch through `PROPERTIES[kind]` when
the column declares one; otherwise legacy `renderRowValue` behavior
applies (backward compatible).

**Package boundary.** This package is a pure renderer — it consumes a
typed `ViewPayload` (re-exported from `@sidanclaw/core`) and produces
React elements. **It does not fetch data, validate auth, or know about
sidanclaw primitives.** Hosts (apps/web, future apps/feed-web, future
mobile apps) supply data and an `onAction` handler.

## Why a separate package

The cross-surface property in §16: a Flutter or React-Native renderer
shipping later consumes the **same** `ViewPayload` JSON the React
renderer here consumes. Keeping the renderer out of `apps/web` enforces
that boundary — apps/web cannot reach into the renderer for primitive
data, and the renderer cannot reach into apps/web for fetching.

## A2UI v0.8 widget catalog (in scope)

| Widget | Component | Notes |
|---|---|---|
| Container | `<Container>` | `direction: column \| row` |
| Heading | `<Heading>` | `level: 1 \| 2 \| 3 \| 4` (H4 = Notion `####`) |
| Text | `<Text>` | `variant: body \| muted \| caption` |
| Badge | `<Badge>` | `tone: default \| success \| warning \| danger` |
| Button | `<Button>` | Fires `onAction(actionId, params)` |
| Image | `<Image>` | Avatar slot only |
| Person *(Phase 1)* | `properties/person.tsx` Cell | `{ id, name, avatarUrl?, initials? }` — server pre-resolved |
| Relation *(Phase 1)* | `properties/relation.tsx` Cell | `{ entityType, id, label }` — server pre-resolved; clickable when host wires `onAction` |
| Date *(Phase 1)* | `properties/date.tsx` Cell | `{ iso \| null, format: 'relative' \| 'absolute' \| 'datetime' }` |
| Number *(Phase 1)* | `properties/number.tsx` Cell | `{ value \| null, format: 'plain' \| 'currency' \| 'percent' \| 'integer', currency? }` |
| Table | `<Table>` | TanStack Table v8 + property-kind dispatch |
| Board | `<Board>` | dnd-kit |

Anything outside this catalog renders via `<Fallback>` — a soft-fail div
that emits a console.warn. Never throws — a v0.9 payload mistakenly
served must not crash the chat surface.

## Property registry (Phase 1 — Notion-feel)

`src/properties/` — one module per `PropertyKind`. Each exports
`{ kind, Cell, Editor, Icon, sortFn }`:

| Kind | Module | What the Cell renders | Sort |
|---|---|---|---|
| `text` | `text.tsx` | Plain text span (default kind) | lexical |
| `select` | `select.tsx` | Badge pill (BadgeWidget or bare string) | by text |
| `tags` | `tags.tsx` | Wrap of Badge pills (Container<Badge[]>) | count → alpha |
| `person` | `person.tsx` | Avatar + name pill | by name |
| `relation` | `relation.tsx` | Entity pill (clickable when onAction) | by label |
| `date` | `date.tsx` | Formatted date (relative/absolute/datetime) | by ISO |
| `number` | `number.tsx` | Right-aligned, tabular numerals | numeric |

`Table.tsx` dispatches the cell through `PROPERTIES[column.kind]` when
the column declares one, falling through to legacy `renderRowValue` for
untagged columns. Headers get a 12px property icon glyph next to the
header text. **Inline cell editing is live:** `Table.tsx` renders the
property's `Editor` in place on cell click and commits via
`onAction('cell-update', { entity, rowId, field, value })`. `select`/`status`
editors read their option lists from `PropertyEditorHints`, which `Table.tsx`
builds from the column's `options` / `statusGroups` (emitted by the server's
`buildPayload`). Editor-less kinds (`person`/`relation`/auto-stamp) and a
`status` column without groups stay read-only (edit via the host's row drawer).

## Public API

```ts
import { ViewRenderer, type ViewRendererProps } from '@sidanclaw/views-renderer'

<ViewRenderer
  payload={payload}              // A2UI v0.8 ViewPayload
  onAction={(actionId, params) => { /* host-defined */ }}
/>
```

The schema (`viewPayloadSchema`) lives in `@sidanclaw/core/views/a2ui.ts`
— validation happens at the renderer's boundary on every mount. This
package re-exports the types but **not** the schema.

## Tests

`pnpm --filter @sidanclaw/views-renderer test` — unit tests of the
dispatch function and the soft-fail behavior. No DOM-level rendering
tests yet (no DOM lib installed in this workspace); add when needed.
