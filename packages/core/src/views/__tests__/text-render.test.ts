/**
 * [COMP:views/text-render] Plain-text rendering of A2UI payloads for
 * channels that cannot mount the interactive renderer.
 */

import { describe, expect, it } from 'vitest'
import type { ViewPayload } from '../a2ui.js'
import { cellText, renderPayloadText } from '../text-render.js'

function payload(root: ViewPayload['root']): ViewPayload {
  return { a2ui: '0.8', root }
}

describe('[COMP:views/text-render] cellText', () => {
  it('flattens primitives and null', () => {
    expect(cellText('hello')).toBe('hello')
    expect(cellText(42)).toBe('42')
    expect(cellText(null)).toBe('')
  })

  it('flattens resolved widgets to their labels', () => {
    expect(cellText({ type: 'person', id: 'p1', name: 'Ada Example' })).toBe('Ada Example')
    expect(cellText({ type: 'relation', entityType: 'company', id: 'c1', label: 'Acme' })).toBe('Acme')
    expect(cellText({ type: 'badge', text: 'qualified' })).toBe('qualified')
    expect(cellText({ type: 'date', iso: '2026-08-19T12:00:00Z' })).toBe('2026-08-19')
    expect(cellText({ type: 'date', iso: null })).toBe('')
    expect(cellText({ type: 'number', value: 15000, format: 'currency', currency: 'USD' })).toBe('USD 15000')
    expect(cellText({ type: 'status', optionId: 'opt-1', label: 'In progress' })).toBe('In progress')
  })

  it('degrades an unknown widget to a best-effort label', () => {
    expect(cellText({ type: 'mystery', label: 'still readable' } as never)).toBe('still readable')
    expect(cellText({ type: 'mystery' } as never)).toBe('')
  })
})

describe('[COMP:views/text-render] renderPayloadText', () => {
  it('renders a table as an aligned fenced code block', () => {
    const text = renderPayloadText(
      payload({
        type: 'table',
        columns: [
          { field: 'name', header: 'Deal' },
          { field: 'stage', header: 'Stage' },
        ],
        rows: [
          { name: 'Acme rollout', stage: { type: 'badge', text: 'lead' } },
          { name: 'Beta pilot', stage: { type: 'badge', text: 'qualified' } },
        ],
      }),
    )
    expect(text.startsWith('```\n')).toBe(true)
    expect(text.endsWith('\n```')).toBe(true)
    expect(text).toContain('Deal')
    expect(text).toContain('Acme rollout  lead')
    expect(text).toContain('Beta pilot    qualified')
  })

  it('caps table rows and reports the remainder', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `Row ${i}` }))
    const text = renderPayloadText(
      payload({ type: 'table', columns: [{ field: 'name', header: 'Name' }], rows }),
      { maxRows: 3 },
    )
    expect(text).toContain('Row 2')
    expect(text).not.toContain('Row 3')
    expect(text).toContain('(+2 more)')
  })

  it('renders a board as grouped lists with card detail', () => {
    const text = renderPayloadText(
      payload({
        type: 'board',
        groupBy: 'stage',
        cardSchema: { type: 'text', text: '' },
        columns: [
          {
            id: 'lead',
            title: 'lead',
            cards: [
              { id: 'd1', data: { id: 'd1', name: 'Acme rollout', amount: { type: 'number', value: 15000 } } },
            ],
          },
          { id: 'won', title: 'won', cards: [] },
        ],
      }),
    )
    expect(text).toContain('*lead* (1)')
    expect(text).toContain('- Acme rollout (15000)')
    expect(text).toContain('*won* (0)')
  })

  it('renders a calendar grouped by day, skipping undated rows', () => {
    const text = renderPayloadText(
      payload({
        type: 'calendar',
        dateColumnId: 'due',
        columns: [
          { field: 'title', header: 'Title' },
          { field: 'due', header: 'Due', kind: 'date' },
        ],
        rows: [
          { title: 'Ship report', due: { type: 'date', iso: '2026-08-20T00:00:00Z' } },
          { title: 'No date task', due: { type: 'date', iso: null } },
        ],
      }),
    )
    expect(text).toContain('*2026-08-20*')
    expect(text).toContain('- Ship report')
    expect(text).not.toContain('No date task')
  })

  it('renders chart widgets as label: value lines', () => {
    expect(
      renderPayloadText(payload({ type: 'kpi', label: 'Total deals', value: 7 })),
    ).toBe('Total deals: 7')
    expect(
      renderPayloadText(
        payload({ type: 'chart_bar', title: 'By status', data: [{ label: 'open', value: 3 }] }),
      ),
    ).toBe('By status\n- open: 3')
    expect(
      renderPayloadText(
        payload({
          type: 'chart_pie',
          slices: [
            { label: 'won', value: 1 },
            { label: 'lost', value: 3 },
          ],
        }),
      ),
    ).toBe('- won: 1 (25%)\n- lost: 3 (75%)')
    expect(
      renderPayloadText(
        payload({
          type: 'chart_line',
          series: [{ name: 'deals', points: [{ x: '2026-08', y: 4 }] }],
        }),
      ),
    ).toBe('deals: 2026-08: 4')
  })

  it('returns empty string for widget kinds with no text form', () => {
    expect(
      renderPayloadText(payload({ type: 'divider' })),
    ).toBe('')
  })
})
