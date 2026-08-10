import { describe, expect, it, vi } from 'vitest'
import {
  gdriveCatalogScopeSchema,
  scanGDriveCatalog,
} from '../drive-catalog.js'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

describe('[COMP:integrations/gdrive-enrichment] Drive metadata catalog discovery', () => {
  it('pages the entire visible Drive and resolves folder paths without content reads', async () => {
    const listPage = vi.fn()
      .mockResolvedValueOnce({
        files: [
          { id: 'folder-1', name: 'Company', mimeType: FOLDER_MIME },
          { id: 'doc-1', name: 'Renewal playbook', mimeType: 'application/vnd.google-apps.document', version: '7', parents: ['folder-1'] },
        ],
        nextPageToken: 'next-1',
      })
      .mockResolvedValueOnce({
        files: [
          { id: 'sheet-1', name: 'Forecast', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-08-10T00:00:00.000Z' },
        ],
      })

    const result = await scanGDriveCatalog({
      accessToken: 'access-1',
      syncScope: 'entire_drive',
      selectedFolders: [],
      listPage,
    })

    expect(listPage).toHaveBeenNthCalledWith(2, 'access-1', expect.objectContaining({ pageToken: 'next-1' }))
    expect(result).toMatchObject({ fileCount: 2, totalItems: 3 })
    expect(result.entries.find((entry) => entry.externalFileId === 'doc-1')?.folderPath).toEqual(['Company'])
  })

  it('walks selected folders recursively and de-duplicates shared descendants', async () => {
    const listPage = vi.fn(async (_token: string, params: { folderId?: string }) => {
      if (params.folderId === 'root-1') {
        return { files: [
          { id: 'nested-1', name: 'Sales', mimeType: FOLDER_MIME, parents: ['root-1'] },
          { id: 'doc-1', name: 'Account plan', mimeType: 'text/plain', version: '3', parents: ['root-1'] },
        ] }
      }
      if (params.folderId === 'nested-1') {
        return { files: [
          { id: 'doc-2', name: 'Renewal notes', mimeType: 'text/plain', version: '4', parents: ['nested-1'] },
        ] }
      }
      return { files: [] }
    })

    const result = await scanGDriveCatalog({
      accessToken: 'access-1',
      syncScope: 'selected_folders',
      selectedFolders: [{ id: 'root-1', name: 'Company' }],
      listPage: listPage as never,
      getFile: vi.fn(async () => ({ id: 'root-1', name: 'Company', mimeType: FOLDER_MIME })),
    })

    expect(result).toMatchObject({ fileCount: 2, totalItems: 4 })
    expect(result.entries.find((entry) => entry.externalFileId === 'doc-2')?.folderPath).toEqual(['Company', 'Sales'])
    expect(listPage).toHaveBeenCalledWith('access-1', expect.objectContaining({ folderId: 'nested-1' }))
  })

  it('strictly requires roots for selected-folder scope and none for Entire Drive', () => {
    expect(gdriveCatalogScopeSchema.safeParse({
      syncScope: 'selected_folders', selectedFolders: [],
    }).success).toBe(false)
    expect(gdriveCatalogScopeSchema.safeParse({
      syncScope: 'entire_drive', selectedFolders: [{ id: 'folder-1', name: 'Company' }],
    }).success).toBe(false)
  })

  it('stops before an oversized catalog is queued', async () => {
    const listPage = vi.fn().mockResolvedValue({
      files: [
        { id: 'one', name: 'One', mimeType: 'text/plain' },
        { id: 'two', name: 'Two', mimeType: 'text/plain' },
      ],
    })
    await expect(scanGDriveCatalog({
      accessToken: 'access-1',
      syncScope: 'entire_drive',
      selectedFolders: [],
      maxItems: 1,
      listPage,
    })).rejects.toThrow('Select fewer folders')
  })
})
