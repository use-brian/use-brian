import { describe, expect, it } from 'vitest'
import {
  PUBLIC_TRANSCRIPT_PAGE,
  pageRecordingIdOf,
  publicRecordingSummary,
  transcriptWindow,
} from '../_public-recording.js'
import type { Recording } from '../../db/recordings-store.js'

const rec = (over: Partial<Recording> = {}): Recording =>
  ({
    id: 'rec-1',
    workspaceId: 'ws-1',
    title: 'Q3 planning',
    kind: 'meeting',
    status: 'processed',
    fileName: 'meeting-2026-07-22.m4a',
    mime: 'audio/mp4',
    gcsKey: 'ws-1/recordings/f1',
    storageUri: null,
    bytes: 1000,
    durationMs: 6_010_000,
    transcriptFileId: 'tf-1',
    mediaFileId: 'mf-1',
    participants: [],
    truncated: false,
    lastError: null,
    deleteAfter: null,
    userId: null,
    assistantId: null,
    sensitivity: 'internal',
    createdByUserId: 'u-1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }) as Recording

describe('[COMP:doc/public-recording] Shared-page recording resolution', () => {
  it('pageRecordingIdOf: the synthesis anchor wins over a manual link', () => {
    expect(
      pageRecordingIdOf({
        anchorKey: 'recording-synthesis:anchor-rec',
        linkedRecordingId: 'manual-rec',
      }),
    ).toBe('anchor-rec')
  })

  it('pageRecordingIdOf: a manual link fills the gap on a non-brief page', () => {
    expect(pageRecordingIdOf({ anchorKey: null, linkedRecordingId: 'manual-rec' })).toBe('manual-rec')
    expect(pageRecordingIdOf({ anchorKey: 'workflow:x', linkedRecordingId: 'manual-rec' })).toBe(
      'manual-rec',
    )
  })

  it('pageRecordingIdOf: no pointer → null (the page renders no chrome)', () => {
    expect(pageRecordingIdOf({ anchorKey: null, linkedRecordingId: null })).toBeNull()
  })

  it('publicRecordingSummary is the NARROW projection: no file name, no storage key, no participants', () => {
    const summary = publicRecordingSummary(rec())
    expect(summary).toEqual({ recordingId: 'rec-1', durationMs: 6_010_000, truncated: false })
    // The projection must not widen silently — a new field here is a
    // deliberate decision about what an anonymous viewer may see.
    expect(Object.keys(summary).sort()).toEqual(['durationMs', 'recordingId', 'truncated'])
  })
})

describe('[COMP:doc/public-recording] Anonymous transcript window', () => {
  it('bounds every request to one page — an unbounded pull cannot take a meeting whole', () => {
    expect(transcriptWindow('0')).toEqual({ from: 0, to: PUBLIC_TRANSCRIPT_PAGE - 1 })
    expect(transcriptWindow('200')).toEqual({ from: 200, to: 200 + PUBLIC_TRANSCRIPT_PAGE - 1 })
  })

  it('missing fromIndex starts at 0; a fractional index floors', () => {
    expect(transcriptWindow(undefined)).toEqual({ from: 0, to: PUBLIC_TRANSCRIPT_PAGE - 1 })
    expect(transcriptWindow('10.9')?.from).toBe(10)
  })

  it('rejects a negative or non-numeric fromIndex', () => {
    expect(transcriptWindow('-1')).toBeNull()
    expect(transcriptWindow('abc')).toBeNull()
  })
})
