/** Generic doc-sync namespace router. `page:<id>` and the historical bare page
 * id are byte-compatible; `office:<artifact-id>` selects the Office codec. */
export type SyncDocumentTarget =
  | { kind: 'page'; id: string; legacyBareName: boolean }
  | { kind: 'office'; id: string; legacyBareName: false }

export function parseSyncDocumentName(name: string): SyncDocumentTarget {
  if (name.startsWith('office:')) {
    const id = name.slice('office:'.length)
    if (!id) throw new Error('invalid empty Office document id')
    return { kind: 'office', id, legacyBareName: false }
  }
  if (name.startsWith('page:')) {
    const id = name.slice('page:'.length)
    if (!id) throw new Error('invalid empty page document id')
    return { kind: 'page', id, legacyBareName: false }
  }
  if (name.includes(':')) throw new Error('unsupported doc-sync document namespace')
  if (!name) throw new Error('invalid empty document id')
  return { kind: 'page', id: name, legacyBareName: true }
}

export function officeDocumentName(artifactId: string): string {
  return `office:${artifactId}`
}
