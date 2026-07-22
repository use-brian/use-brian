import { describe, expect, it } from 'vitest'
import {
  RECORDING_SYNTHESIS_ANCHOR_PREFIX,
  recordingAnchorKey,
  recordingIdFromAnchorKey,
} from '../recording-anchor.js'

describe('[COMP:media/recording-anchor] recording anchor key', () => {
  it('round-trips: the key the synthesizer writes is the id the readers parse', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(recordingIdFromAnchorKey(recordingAnchorKey(id))).toBe(id)
  })

  it('builds with the shared prefix', () => {
    expect(recordingAnchorKey('x')).toBe(`${RECORDING_SYNTHESIS_ANCHOR_PREFIX}x`)
  })

  it('returns null for non-recording anchors, null, undefined, and a bare prefix', () => {
    expect(recordingIdFromAnchorKey('workflow:abc')).toBeNull()
    expect(recordingIdFromAnchorKey(null)).toBeNull()
    expect(recordingIdFromAnchorKey(undefined)).toBeNull()
    expect(recordingIdFromAnchorKey(RECORDING_SYNTHESIS_ANCHOR_PREFIX)).toBeNull()
    expect(recordingIdFromAnchorKey(`${RECORDING_SYNTHESIS_ANCHOR_PREFIX}  `)).toBeNull()
  })
})
