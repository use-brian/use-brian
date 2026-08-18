import { describe, expect, it } from 'vitest'
import { LIVE_MARKER_ID_PREFIX, hasLiveMarkerBlock } from '../live-recording.js'

describe('[COMP:media/live-recording-marker] live capture marker', () => {
  it('detects the live marker block by its well-known id prefix', () => {
    expect(hasLiveMarkerBlock([{ id: 'abc' }, { id: `${LIVE_MARKER_ID_PREFIX}123` }])).toBe(true)
    expect(hasLiveMarkerBlock([{ id: 'abc' }, { id: 'alive:no' }])).toBe(false)
    expect(hasLiveMarkerBlock([])).toBe(false)
    expect(hasLiveMarkerBlock(undefined)).toBe(false)
    expect(hasLiveMarkerBlock(null)).toBe(false)
  })

  it('ignores blocks whose id is not a string', () => {
    expect(hasLiveMarkerBlock([{ id: 7 }, {}])).toBe(false)
  })
})
