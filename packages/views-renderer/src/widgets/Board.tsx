/**
 * A2UI Board — kanban-style columns with sortable + cross-column drag.
 *
 * Built on @dnd-kit/core + @dnd-kit/sortable. The renderer is action-
 * agnostic: a successful drop fires `onAction('move-card', { cardId,
 * fromCol, toCol })`. The host wires this to whatever write makes sense
 * for the entity (tasks → updateTask({status}); deals → setDealStage).
 *
 * `cardSchema` is rendered for each card with the card's `data` dict
 * available as variable references. v1 supports a literal `{{field}}`
 * substitution against `card.data` — see `interpolateCardSchema`.
 *
 * [COMP:views/board]
 */

import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type JSX, useMemo, useState } from 'react'
import type {
  A2UIBoardCard,
  A2UIBoardColumn,
  A2UIRowValue,
  A2UIWidget,
  OnActionHandler,
} from '../types.js'
import { renderWidget } from '../render.js'

export type BoardProps = {
  groupBy: string
  columns: A2UIBoardColumn[]
  cardSchema: A2UIWidget
  onAction?: OnActionHandler
}

export function Board(props: BoardProps): JSX.Element {
  // Local state mirrors the props so optimistic drops show immediately;
  // the host's onAction triggers a server write + a re-render with
  // updated payload. See "frozen-arguments" in the workflow plan for
  // similar split-state semantics.
  const [columns, setColumns] = useState<A2UIBoardColumn[]>(props.columns)

  // If the parent re-renders with new payload (e.g. after refetch), pick
  // it up. We compare by shallow card-id signatures rather than deep
  // equality to avoid resetting drag state on identical re-renders.
  const propsSignature = useMemo(
    () => columnSignature(props.columns),
    [props.columns],
  )
  const localSignature = useMemo(() => columnSignature(columns), [columns])
  if (propsSignature !== localSignature && propsSignature !== columnSignature(columns)) {
    // Cheap synchronous reconcile.
    setColumns(props.columns)
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over) return
    const cardId = String(active.id)
    const fromCol = findCardColumn(columns, cardId)
    if (!fromCol) return

    const overId = String(over.id)
    const toCol = columns.find((c) => c.id === overId)
      ?? findCardColumn(columns, overId)
    if (!toCol) return
    if (fromCol.id === toCol.id) return

    // Optimistic local move.
    setColumns((prev) => moveCard(prev, cardId, fromCol.id, toCol.id))

    // Notify host. The host issues a write and (eventually) re-renders
    // with an updated payload, which propagates back via props.
    props.onAction?.('move-card', { cardId, fromCol: fromCol.id, toCol: toCol.id })
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="flex flex-row gap-3 overflow-x-auto pb-2">
        {columns.map((col) => (
          <BoardColumn
            key={col.id}
            column={col}
            cardSchema={props.cardSchema}
            onAction={props.onAction}
          />
        ))}
      </div>
    </DndContext>
  )
}

function BoardColumn(props: {
  column: A2UIBoardColumn
  cardSchema: A2UIWidget
  onAction?: OnActionHandler
}): JSX.Element {
  const cardIds = props.column.cards.map((c) => c.id)
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-md border border-border bg-muted/30 p-2">
      <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
        <span className="capitalize">{props.column.title || props.column.id}</span>
        <span>{props.column.cards.length}</span>
      </div>
      <SortableContext id={props.column.id} items={cardIds} strategy={rectSortingStrategy}>
        <div className="flex flex-col gap-2">
          {props.column.cards.map((card) => (
            <BoardCard
              key={card.id}
              card={card}
              cardSchema={props.cardSchema}
              onAction={props.onAction}
            />
          ))}
          {props.column.cards.length === 0 && (
            <div className="rounded border border-dashed border-border/50 p-4 text-center text-xs text-muted-foreground">
              empty
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  )
}

function BoardCard(props: {
  card: A2UIBoardCard
  cardSchema: A2UIWidget
  onAction?: OnActionHandler
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.card.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // Interpolate `{{field}}` references in the card schema against the
  // card's data dict. Returns a fresh widget tree each render — small
  // cost, big simplicity win over closure-baked schemas.
  const rendered = useMemo(
    () => interpolateCardSchema(props.cardSchema, props.card.data),
    [props.cardSchema, props.card.data],
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="cursor-grab rounded-md border border-border bg-background p-2 shadow-sm hover:border-foreground/20 active:cursor-grabbing"
    >
      {renderWidget(rendered, props.onAction)}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function columnSignature(cols: A2UIBoardColumn[]): string {
  return cols.map((c) => `${c.id}:${c.cards.map((card) => card.id).join(',')}`).join('|')
}

function findCardColumn(
  cols: A2UIBoardColumn[],
  cardId: string,
): A2UIBoardColumn | undefined {
  return cols.find((c) => c.cards.some((card) => card.id === cardId))
}

function moveCard(
  cols: A2UIBoardColumn[],
  cardId: string,
  fromColId: string,
  toColId: string,
): A2UIBoardColumn[] {
  const card = cols.find((c) => c.id === fromColId)?.cards.find((cc) => cc.id === cardId)
  if (!card) return cols
  return cols.map((c) => {
    if (c.id === fromColId) {
      return { ...c, cards: c.cards.filter((cc) => cc.id !== cardId) }
    }
    if (c.id === toColId) {
      return { ...c, cards: [...c.cards, card] }
    }
    return c
  })
}

/**
 * Replace `{{field}}` references in a widget's text with the card's
 * data dict. Walks the widget tree non-destructively. Unknown field
 * references render as empty string. Widget values inside `data` are
 * substituted in place (used by Badge cells whose tone needs to come
 * from the card data).
 */
export function interpolateCardSchema(
  widget: A2UIWidget,
  data: Record<string, A2UIRowValue>,
): A2UIWidget {
  switch (widget.type) {
    case 'container':
      return {
        ...widget,
        children: widget.children.map((c) => interpolateCardSchema(c, data)),
      }
    case 'text':
    case 'badge':
    case 'heading':
    case 'button':
      return { ...widget, text: interpolateString(widget.text, data) }
    case 'image':
      return { ...widget, src: interpolateString(widget.src, data), alt: interpolateString(widget.alt, data) }
    case 'person':
    case 'relation':
    case 'date':
    case 'number':
    case 'divider':
      // Inert leaves in a card schema — no `{{field}}` substitution.
      return widget
    case 'table':
    case 'board':
      // Nested table/board inside a card schema is out of scope for v1.
      return widget
    case 'kpi':
    case 'chart_bar':
    case 'chart_line':
    case 'chart_pie':
      // Charts inside a card schema are out of scope — Phase 4 charts
      // are top-level page blocks, never embedded in a board card.
      return widget
    default:
      // Status / Files / other widgets added by later doc-v1 batches
      // are inert leaves inside a board-card schema — no string
      // interpolation. Returning the widget unchanged keeps Board
      // compiling as the A2UIWidget union grows.
      return widget
  }
}

const PLACEHOLDER_RE = /\{\{([\w.]+)\}\}/g

function interpolateString(template: string, data: Record<string, A2UIRowValue>): string {
  return template.replace(PLACEHOLDER_RE, (_, key: string) => {
    const value = data[key]
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    // Widget value — extract its surface text if present.
    if (value.type === 'badge' || value.type === 'text' || value.type === 'heading' || value.type === 'button') {
      return value.text
    }
    if (value.type === 'image') return value.alt
    if (value.type === 'person') return value.name
    if (value.type === 'relation') return value.label
    if (value.type === 'date') return value.iso ?? ''
    if (value.type === 'number') return value.value === null ? '' : String(value.value)
    return ''
  })
}
