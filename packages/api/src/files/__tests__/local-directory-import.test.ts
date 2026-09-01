import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isSafeLocalStorageKey,
  scanLocalDirectory,
  storageKeyForWorkspaceFile,
} from '../local-directory-import.js'

const WS = '11111111-1111-1111-1111-111111111111'

describe('[COMP:files/local-directory-import] scanLocalDirectory', () => {
  it('inventories regular files while skipping sidecars, symlinks, and managed workspace bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brian-local-import-'))
    try {
      await mkdir(join(root, 'docs'))
      await writeFile(join(root, 'docs', 'plan.md'), 'hello')
      await writeFile(join(root, 'image.png'), Buffer.from([1, 2, 3]))
      await writeFile(join(root, 'image.png.meta.json'), '{}')
      await mkdir(join(root, WS))
      await writeFile(join(root, WS, 'managed-id'), 'managed')
      await symlink(join(root, 'docs', 'plan.md'), join(root, 'linked.md'))

      const scan = await scanLocalDirectory({ rootPath: root, workspaceId: WS })

      expect(scan.truncated).toBe(false)
      expect(scan.fileCount).toBe(2)
      expect(scan.totalBytes).toBe(8)
      expect(scan.files.map((file) => file.relativePath)).toEqual(['docs/plan.md', 'image.png'])
      expect(scan.files[0]).toMatchObject({
        brainPath: '/local/docs/plan.md',
        parentPath: '/local/docs',
        mime: 'text/markdown',
        fingerprint: expect.stringMatching(/^5:/),
      })
      expect(scan.files[1]?.storageUri).toMatch(/^file:/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports truncation at the bounded file limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brian-local-limit-'))
    try {
      await writeFile(join(root, 'a.txt'), 'a')
      await writeFile(join(root, 'b.txt'), 'b')
      const scan = await scanLocalDirectory({ rootPath: root, workspaceId: WS, maxFiles: 1 })
      expect(scan.fileCount).toBe(1)
      expect(scan.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('[COMP:files/local-directory-import] imported storage keys', () => {
  it('uses a validated original relative path and rejects traversal shapes', () => {
    expect(isSafeLocalStorageKey('docs/plan.md')).toBe(true)
    expect(isSafeLocalStorageKey('../secret.txt')).toBe(false)
    expect(isSafeLocalStorageKey('/etc/passwd')).toBe(false)
    expect(isSafeLocalStorageKey('docs//plan.md')).toBe(false)
    expect(storageKeyForWorkspaceFile({
      id: 'file-id',
      workspaceId: WS,
      storageUri: 'file:///Users/someone/notes/docs/plan.md',
      metadata: {
        localDirectory: {
          connectorInstanceId: 'instance-id',
          relativePath: 'docs/plan.md',
          fingerprint: '5:1',
          readOnly: true,
        },
      },
    })).toBe('docs/plan.md')
  })

  // The recording-media regression (2026-09-01): `media-artifact.ts` indexes an
  // object that already exists at `<workspace>/recordings/<uuid>` and never
  // copies it, so re-deriving `<workspace>/<row id>` looked in a place nothing
  // had ever written and every such read answered not_found.
  it('reads the object key out of storage_uri rather than re-deriving it', () => {
    expect(storageKeyForWorkspaceFile({
      id: 'row-id',
      workspaceId: WS,
      storageUri: `gs://bucket-name/${WS}/recordings/media-uuid`,
      metadata: {},
    })).toBe(`${WS}/recordings/media-uuid`)
  })

  it('agrees with the legacy derivation for an ordinary written file', () => {
    expect(storageKeyForWorkspaceFile({
      id: 'row-id',
      workspaceId: WS,
      storageUri: `gs://bucket-name/${WS}/row-id`,
      metadata: {},
    })).toBe(`${WS}/row-id`)
  })

  it('falls back to the legacy derivation when storage_uri cannot be parsed', () => {
    expect(storageKeyForWorkspaceFile({
      id: 'row-id',
      workspaceId: WS,
      storageUri: 'not-a-storage-uri',
      metadata: {},
    })).toBe(`${WS}/row-id`)
  })
})
