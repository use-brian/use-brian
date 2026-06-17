/**
 * Unit tests for the channels store.
 * Component tag: [COMP:channels/store].
 *
 * Covers the pure surface→assistant routing rule (`pickAssistantForSurface`).
 * The DB paths (channel CRUD, routing reads under RLS) need a live Postgres
 * and are out of scope here — same boundary as `channel-integrations.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { pickAssistantForSurface, type ChannelAssistant } from '../channels-store.js'

function row(assistantId: string, externalSurfaceId: string | null): ChannelAssistant {
  return {
    id: `ca-${assistantId}-${externalSurfaceId ?? 'default'}`,
    channelId: 'chan-1',
    assistantId,
    externalSurfaceId,
    modelAlias: 'standard',
    createdAt: new Date('2026-05-18T00:00:00Z'),
  }
}

describe('[COMP:channels/store] pickAssistantForSurface', () => {
  it('returns the default (NULL-surface) assistant when no surface is given', () => {
    const rows = [row('asst-default', null), row('asst-eng', 'C-ENG')]
    expect(pickAssistantForSurface(rows, null)).toBe('asst-default')
  })

  it('prefers a surface-specific assistant over the default', () => {
    const rows = [row('asst-default', null), row('asst-eng', 'C-ENG')]
    expect(pickAssistantForSurface(rows, 'C-ENG')).toBe('asst-eng')
  })

  it('falls back to the default when the surface has no specific mapping', () => {
    const rows = [row('asst-default', null), row('asst-eng', 'C-ENG')]
    expect(pickAssistantForSurface(rows, 'C-SALES')).toBe('asst-default')
  })

  it('returns null when there are no routing rows at all', () => {
    expect(pickAssistantForSurface([], 'C-ENG')).toBeNull()
    expect(pickAssistantForSurface([], null)).toBeNull()
  })

  it('returns null when a surface misses and no default exists', () => {
    const rows = [row('asst-eng', 'C-ENG')]
    expect(pickAssistantForSurface(rows, 'C-SALES')).toBeNull()
    expect(pickAssistantForSurface(rows, null)).toBeNull()
  })

  it('routes a mapped surface even when the channel has no default', () => {
    const rows = [row('asst-eng', 'C-ENG'), row('asst-sales', 'C-SALES')]
    expect(pickAssistantForSurface(rows, 'C-SALES')).toBe('asst-sales')
  })
})
