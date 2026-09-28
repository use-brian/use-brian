import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parsePdfSession } from '../pdf/index.js'
import { createFlatPdfFixture, createSupportedPdfFixture } from './fixtures/pdf/index.js'

const id = (ordinal: number) => `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`

function input(bytes: Uint8Array) {
  return {
    bytes,
    artifactId: id(1),
    workspaceId: id(2),
    ownerUserId: id(3),
    fileId: id(4),
    originalFileName: 'fictional-form.example.pdf',
    title: 'Fictional form',
    locale: 'en-US',
  }
}

describe('[COMP:office/pdf-engine] PDF admission parser', () => {
  it('projects supported fields, duplicate widgets, page geometry, and empty signature targets deterministically', async () => {
    const bytes = await createSupportedPdfFixture()
    const first = await parsePdfSession(input(bytes))
    const second = await parsePdfSession(input(bytes))

    expect(first).toEqual(second)
    expect(first.source.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(first.pages).toHaveLength(2)
    expect(first.pages[1]).toMatchObject({ sourcePageIndex: 1, cropBox: { width: 500, height: 700 }, rotation: 90 })
    const fields = first.pages.flatMap((page) => page.fields)
    expect(fields.map((field) => field.kind).sort()).toEqual([
      'checkbox',
      'dropdown',
      'option-list',
      'radio',
      'signature',
      'text',
    ])
    expect(fields.find((field) => field.kind === 'text')?.widgets).toHaveLength(2)
    expect(fields.find((field) => field.kind === 'radio')?.allowedOptions).toEqual(['0', '1'])
    expect(fields.find((field) => field.kind === 'dropdown')?.allowedOptions).toEqual(['north', 'south'])
    expect(fields.find((field) => field.kind === 'signature')?.value).toBeNull()
    expect(first.pages.flatMap((page) => page.placementTargets)).toEqual([
      expect.objectContaining({ purpose: 'signature', creatorUserId: id(3), creationVersion: 0 }),
    ])
  })

  it('accepts a flat vector PDF without inventing fields or signature targets', async () => {
    const snapshot = await parsePdfSession(input(await createFlatPdfFixture()))
    expect(snapshot.pages).toHaveLength(2)
    expect(snapshot.pages.flatMap((page) => page.fields)).toEqual([])
    expect(snapshot.pages.flatMap((page) => page.placementTargets)).toEqual([])
  })
})
