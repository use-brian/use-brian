import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { appendOfficeCommand, applyOfficeUpdate, encodeOfficeState, snapshotToYDoc, yDocToSnapshot } from '../collab.js'
import { documentFixture, id } from './fixtures.js'

describe('[COMP:office/collab-codec] Office Yjs codec', () => {
  it('round-trips a canonical snapshot exactly', () => {
    const snapshot = documentFixture()
    expect(yDocToSnapshot(snapshotToYDoc(snapshot))).toEqual(snapshot)
  })

  it('merges two independently authored command records idempotently', () => {
    const snapshot = documentFixture()
    const first = snapshotToYDoc(snapshot)
    const second = new Y.Doc()
    applyOfficeUpdate(second, encodeOfficeState(first))
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const }
    appendOfficeCommand(first, { ...common, commandId: id(41), kind: 'setObjectProperty', targetId: id(6), path: ['alignment'], value: 'center' })
    appendOfficeCommand(second, { ...common, commandId: id(42), kind: 'setObjectProperty', targetId: id(6), path: ['styleName'], value: 'Callout' })
    applyOfficeUpdate(first, encodeOfficeState(second))
    applyOfficeUpdate(second, encodeOfficeState(first))
    const left = yDocToSnapshot(first)
    const right = yDocToSnapshot(second)
    expect(left).toEqual(right)
    expect(left.family === 'document' && left.sections[0].nodes[0]).toMatchObject({ alignment: 'center', styleName: 'Callout' })
    applyOfficeUpdate(first, encodeOfficeState(second))
    expect(yDocToSnapshot(first)).toEqual(left)
  })
})
