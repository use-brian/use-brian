/**
 * <ViewRenderer /> — top-level dispatch component.
 *
 * Validates the payload against the A2UI v0.8 Zod schema (unless the
 * caller passes `validated: true`), then walks the widget tree
 * recursively. Unsupported widgets render via <Fallback /> with a
 * console.warn — never throws.
 *
 * [COMP:views/render]
 */

import { Fragment, type JSX } from 'react'
// Import directly from the views/a2ui module rather than the core
// package barrel: the barrel re-exports `skills/loader` which uses
// Node's `fs`, breaking client bundles that include this renderer
// (e.g. apps/web/src/app/chat). Per @sidanclaw/views-renderer/CLAUDE.md,
// "the schema (viewPayloadSchema) lives in @sidanclaw/core/views/a2ui.ts"
// — this matches that intent.
import {
  viewPayloadSchema,
  type A2UIRowValue,
  type A2UIWidget,
  type ViewPayload,
} from '@sidanclaw/core/dist/views/a2ui.js'
import type { OnActionHandler, RenderWidgetOpts, ViewRendererProps } from './types.js'
import { Badge } from './widgets/Badge.js'
import { Button } from './widgets/Button.js'
import { ChartBar } from './widgets/ChartBar.js'
import { ChartLine } from './widgets/ChartLine.js'
import { ChartPie } from './widgets/ChartPie.js'
import { Container } from './widgets/Container.js'
import { Diagram } from './widgets/Diagram.js'
import { Divider } from './widgets/Divider.js'
import { Fallback } from './widgets/Fallback.js'
import { Board } from './widgets/Board.js'
import { Calendar } from './widgets/Calendar.js'
import { Gallery } from './widgets/Gallery.js'
import { Heading } from './widgets/Heading.js'
import { Image } from './widgets/Image.js'
import { Kpi } from './widgets/Kpi.js'
import { List } from './widgets/List.js'
import { Table } from './widgets/Table.js'
import { Text } from './widgets/Text.js'
import { Timeline } from './widgets/Timeline.js'
import { PROPERTIES } from './properties/index.js'

export function ViewRenderer(props: ViewRendererProps): JSX.Element {
  let payload: ViewPayload
  if (props.validated) {
    payload = props.payload as ViewPayload
  } else {
    const parsed = viewPayloadSchema.safeParse(props.payload)
    if (!parsed.success) {
      return (
        <div
          className="text-xs text-rose-700 dark:text-rose-300"
          data-a2ui-error="invalid-payload"
        >
          [invalid view payload]
        </div>
      )
    }
    payload = parsed.data
  }
  return (
    <div className={props.className}>
      {renderWidget(payload.root, props.onAction)}
    </div>
  )
}

/**
 * Recursive widget dispatch. Exported for tests; production callers use
 * <ViewRenderer />.
 */
export function renderWidget(
  widget: A2UIWidget,
  onAction?: OnActionHandler,
  /** Optional key for use in arrays. */
  key?: string | number,
  /** Host options (doc-database chrome + localized table menu copy).
   *  Omitted → legacy table behavior (apps/web inline tables unaffected). */
  opts?: RenderWidgetOpts,
): JSX.Element {
  switch (widget.type) {
    case 'container':
      return (
        <Container key={key} direction={widget.direction}>
          {widget.children.map((child, idx) => renderWidget(child, onAction, idx, opts))}
        </Container>
      )
    case 'heading':
      return <Heading key={key} level={widget.level} text={widget.text} />
    case 'text':
      return <Text key={key} text={widget.text} variant={widget.variant} />
    case 'badge':
      return <Badge key={key} text={widget.text} tone={widget.tone} />
    case 'button':
      return <Button key={key} text={widget.text} action={widget.action} onAction={onAction} />
    case 'image':
      return <Image key={key} src={widget.src} alt={widget.alt} />
    case 'divider':
      return <Divider key={key} />
    case 'person': {
      // PROPERTIES is `Partial<Record<...>>` (registry grows across
      // doc-v1 batches), but every legacy A2UIWidget case here is
      // guaranteed populated by `properties/index.ts` — a missing entry
      // is a wiring bug, not runtime input.
      const P = PROPERTIES.person!
      return <P.Cell key={key} value={widget} onAction={onAction} />
    }
    case 'relation': {
      const P = PROPERTIES.relation!
      return <P.Cell key={key} value={widget} onAction={onAction} />
    }
    case 'date': {
      const P = PROPERTIES.date!
      return <P.Cell key={key} value={widget} onAction={onAction} />
    }
    case 'number': {
      const P = PROPERTIES.number!
      return <P.Cell key={key} value={widget} onAction={onAction} />
    }
    case 'table':
      return (
        <Table
          key={key}
          columns={widget.columns}
          rows={widget.rows}
          rowAction={widget.rowAction}
          onAction={onAction}
          frozenColumnCount={widget.frozenColumnCount}
          sort={widget.sort}
          editableColumns={widget.editableColumns}
          enableColumnMenu={opts?.enableColumnMenu}
          labels={opts?.tableLabels}
        />
      )
    case 'list':
      return (
        <List
          key={key}
          columns={widget.columns}
          rows={widget.rows}
          rowAction={widget.rowAction}
          emptyMessage={widget.emptyMessage}
          onAction={onAction}
        />
      )
    case 'board':
      return (
        <Board
          key={key}
          groupBy={widget.groupBy}
          columns={widget.columns}
          cardSchema={widget.cardSchema}
          onAction={onAction}
        />
      )
    case 'gallery':
      return (
        <Gallery
          key={key}
          rows={widget.rows}
          columns={widget.columns}
          coverColumnId={widget.coverColumnId}
          rowAction={widget.rowAction}
          emptyMessage={widget.emptyMessage}
          onAction={onAction}
        />
      )
    case 'calendar':
      return (
        <Calendar
          key={key}
          rows={widget.rows}
          columns={widget.columns}
          dateColumnId={widget.dateColumnId}
          rowAction={widget.rowAction}
          emptyMessage={widget.emptyMessage}
          initialView={widget.initialView}
          onAction={onAction}
        />
      )
    case 'timeline':
      return (
        <Timeline
          key={key}
          rows={widget.rows}
          columns={widget.columns}
          startColumnId={widget.startColumnId}
          endColumnId={widget.endColumnId}
          rowAction={widget.rowAction}
          emptyMessage={widget.emptyMessage}
          zoomLevel={widget.zoomLevel}
          onAction={onAction}
        />
      )
    case 'kpi':
      return <Kpi key={key} widget={widget} />
    case 'chart_bar':
      return <ChartBar key={key} widget={widget} />
    case 'chart_line':
      return <ChartLine key={key} widget={widget} />
    case 'chart_pie':
      return <ChartPie key={key} widget={widget} />
    case 'diagram':
      return <Diagram key={key} widget={widget} />
    default: {
      // Exhaustive switch: TypeScript flags unhandled widget types here.
      // The runtime cast is for the soft-fail path when a v0.9 payload
      // sneaks past the schema (e.g. with `validated: true`).
      const fallbackType = (widget as { type?: string }).type ?? 'unknown'
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(
          `[views-renderer] Unsupported A2UI widget type "${fallbackType}". ` +
          `Catalog: container, heading, text, badge, button, image, divider, person, relation, date, number, table, list, board, gallery, calendar, timeline, kpi, chart_bar, chart_line, chart_pie, diagram.`,
        )
      }
      return <Fallback key={key} type={fallbackType} />
    }
  }
}

/**
 * Render a single A2UI row value (used by Table cells + Board card data).
 * Primitives → text; widgets → recurse; null → empty fragment.
 */
export function renderRowValue(
  value: A2UIRowValue,
  onAction?: OnActionHandler,
  key?: string | number,
): JSX.Element {
  if (value === null) return <Fragment key={key}></Fragment>
  if (typeof value === 'string' || typeof value === 'number') {
    return <span key={key}>{String(value)}</span>
  }
  return renderWidget(value, onAction, key)
}
