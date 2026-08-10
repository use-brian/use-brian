/**
 * Metadata-only Google Drive discovery for the workspace catalog.
 *
 * This module never downloads file content. It pages through Drive metadata,
 * resolves recursive folder membership, and refreshes the exact OAuth client
 * that minted a connector instance's grant.
 *
 * [COMP:integrations/gdrive-enrichment]
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getConnectorConfig } from '../connector-config.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type {
  GDriveCatalogEntry,
  GDriveCatalogFolder,
  GDriveCatalogScope,
} from '../db/gdrive-catalog-store.js'
import {
  GOOGLE_DRIVE_FOLDER_MIME,
  getDriveFile,
  listDriveFilesPage,
  refreshGoogleAccessToken,
  unpackGoogleRefreshCredential,
  type DriveFile,
} from './client.js'

export const GDRIVE_CATALOG_MAX_ITEMS = 100_000
export const GDRIVE_CATALOG_MAX_ROOT_FOLDERS = 50

const catalogFolderSchema = z.object({
  id: z.string().trim().min(1).max(1024),
  name: z.string().trim().min(1).max(1024),
}).strict()

export const gdriveCatalogScopeSchema = z.object({
  syncScope: z.enum(['entire_drive', 'selected_folders']),
  selectedFolders: z.array(catalogFolderSchema).max(GDRIVE_CATALOG_MAX_ROOT_FOLDERS),
}).strict().superRefine((value, ctx) => {
  if (value.syncScope === 'entire_drive' && value.selectedFolders.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['selectedFolders'], message: 'Entire Drive cannot include selected folders' })
  }
  if (value.syncScope === 'selected_folders' && value.selectedFolders.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['selectedFolders'], message: 'Select at least one folder' })
  }
  const ids = new Set(value.selectedFolders.map((folder) => folder.id))
  if (ids.size !== value.selectedFolders.length) {
    ctx.addIssue({ code: 'custom', path: ['selectedFolders'], message: 'Selected folders must be unique' })
  }
})

export type GDriveCatalogScopeInput = z.infer<typeof gdriveCatalogScopeSchema>

export type GDriveCatalogScanResult = {
  entries: GDriveCatalogEntry[]
  fileCount: number
  totalItems: number
}

type ListPage = typeof listDriveFilesPage
type GetFile = typeof getDriveFile

export async function mintGDriveInstanceAccessToken(input: {
  connectorInstanceId: string
  connectorInstanceStore: Pick<ConnectorInstanceStore, 'getCredentialsSystem'>
}): Promise<string> {
  const stored = await input.connectorInstanceStore.getCredentialsSystem(input.connectorInstanceId)
  const encoded = stored?.client_secret
  if (!encoded) throw new Error('Google Drive connector credentials are missing')
  const grant = unpackGoogleRefreshCredential(encoded)
  const deployment = getConnectorConfig('google')
  const clientId = grant.appClientId ?? deployment?.clientId
  const clientSecret = grant.appClientSecret ?? deployment?.clientSecret
  if (!clientId || !clientSecret) throw new Error('Google OAuth app is not configured for this Drive grant')
  return refreshGoogleAccessToken(grant.refreshToken, clientId, clientSecret)
}

function metadataVersion(file: DriveFile): string {
  const providerVersion = file.version?.trim() || file.modifiedTime?.trim()
  if (providerVersion) return providerVersion
  return `metadata-${createHash('sha256').update(JSON.stringify({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: file.parents ?? [],
    size: file.size ?? null,
  })).digest('hex').slice(0, 24)}`
}

function toEntry(file: DriveFile, folderPath: string[]): GDriveCatalogEntry {
  const sizeNumber = file.size === undefined ? null : Number(file.size)
  return {
    externalFileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sourceVersion: metadataVersion(file),
    modifiedTime: file.modifiedTime ?? null,
    sizeBytes: Number.isFinite(sizeNumber) ? sizeNumber : null,
    webViewLink: file.webViewLink ?? null,
    parentIds: file.parents ?? [],
    folderPath,
    isFolder: file.mimeType === GOOGLE_DRIVE_FOLDER_MIME,
  }
}

function rootDriveFile(folder: GDriveCatalogFolder): DriveFile {
  return {
    id: folder.id,
    name: folder.name,
    mimeType: GOOGLE_DRIVE_FOLDER_MIME,
    webViewLink: `https://drive.google.com/drive/folders/${encodeURIComponent(folder.id)}`,
    parents: [],
  }
}

async function collectPages(input: {
  accessToken: string
  rawQuery?: string
  folderId?: string
  listPage: ListPage
  onFile: (file: DriveFile) => void
}): Promise<void> {
  let pageToken: string | undefined
  do {
    const page = await input.listPage(input.accessToken, {
      maxResults: 1000,
      ...(input.rawQuery ? { rawQuery: input.rawQuery } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
      ...(pageToken ? { pageToken } : {}),
      orderBy: 'name',
    })
    for (const file of page.files) input.onFile(file)
    pageToken = page.nextPageToken
  } while (pageToken)
}

function assertBelowCap(size: number, maxItems: number): void {
  if (size > maxItems) {
    throw new Error(`Google Drive catalog exceeds the ${maxItems.toLocaleString('en-US')} item limit. Select fewer folders.`)
  }
}

function resolveFolderPath(
  file: DriveFile,
  folders: Map<string, DriveFile>,
  memo: Map<string, string[]>,
  visiting = new Set<string>(),
): string[] {
  const parentId = file.parents?.find((id) => folders.has(id))
  if (!parentId) return []
  const cached = memo.get(parentId)
  if (cached) return cached
  if (visiting.has(parentId)) return []
  visiting.add(parentId)
  const parent = folders.get(parentId)!
  const path = [...resolveFolderPath(parent, folders, memo, visiting), parent.name]
  visiting.delete(parentId)
  memo.set(parentId, path)
  return path
}

async function scanEntireDrive(input: {
  accessToken: string
  maxItems: number
  listPage: ListPage
}): Promise<GDriveCatalogScanResult> {
  const files = new Map<string, DriveFile>()
  await collectPages({
    accessToken: input.accessToken,
    rawQuery: 'trashed = false',
    listPage: input.listPage,
    onFile(file) {
      files.set(file.id, file)
      assertBelowCap(files.size, input.maxItems)
    },
  })
  const folders = new Map([...files].filter(([, file]) => file.mimeType === GOOGLE_DRIVE_FOLDER_MIME))
  const memo = new Map<string, string[]>()
  const entries = [...files.values()].map((file) => toEntry(file, resolveFolderPath(file, folders, memo)))
  return {
    entries,
    fileCount: entries.filter((entry) => !entry.isFolder).length,
    totalItems: entries.length,
  }
}

async function scanSelectedFolders(input: {
  accessToken: string
  selectedFolders: GDriveCatalogFolder[]
  maxItems: number
  listPage: ListPage
  getFile: GetFile
}): Promise<GDriveCatalogScanResult> {
  const entries = new Map<string, GDriveCatalogEntry>()
  const queue: Array<{ folder: DriveFile; pathToFolder: string[] }> = []
  for (const selected of input.selectedFolders) {
    const current = await input.getFile(input.accessToken, selected.id)
    if (current.mimeType !== GOOGLE_DRIVE_FOLDER_MIME) {
      throw new Error('A selected Google Drive root is no longer a folder')
    }
    const folder = { ...rootDriveFile(selected), ...current }
    entries.set(folder.id, toEntry(folder, []))
    queue.push({ folder, pathToFolder: [folder.name] })
  }
  assertBelowCap(entries.size, input.maxItems)

  const visitedFolders = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visitedFolders.has(current.folder.id)) continue
    visitedFolders.add(current.folder.id)
    await collectPages({
      accessToken: input.accessToken,
      folderId: current.folder.id,
      listPage: input.listPage,
      onFile(file) {
        entries.set(file.id, toEntry(file, current.pathToFolder))
        assertBelowCap(entries.size, input.maxItems)
        if (file.mimeType === GOOGLE_DRIVE_FOLDER_MIME && !visitedFolders.has(file.id)) {
          queue.push({ folder: file, pathToFolder: [...current.pathToFolder, file.name] })
        }
      },
    })
  }
  const result = [...entries.values()]
  return {
    entries: result,
    fileCount: result.filter((entry) => !entry.isFolder).length,
    totalItems: result.length,
  }
}

export async function scanGDriveCatalog(input: {
  accessToken: string
  syncScope: GDriveCatalogScope
  selectedFolders: GDriveCatalogFolder[]
  maxItems?: number
  listPage?: ListPage
  getFile?: GetFile
}): Promise<GDriveCatalogScanResult> {
  const maxItems = input.maxItems ?? GDRIVE_CATALOG_MAX_ITEMS
  const listPage = input.listPage ?? listDriveFilesPage
  if (input.syncScope === 'entire_drive') {
    return scanEntireDrive({ accessToken: input.accessToken, maxItems, listPage })
  }
  return scanSelectedFolders({
    accessToken: input.accessToken,
    selectedFolders: input.selectedFolders,
    maxItems,
    listPage,
    getFile: input.getFile ?? getDriveFile,
  })
}
