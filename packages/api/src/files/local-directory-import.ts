/**
 * Read-only inventory for a connected Local Directory storage binding.
 *
 * The scanner reads metadata only, never follows symlinks, and deliberately
 * skips Brian's own managed workspace subtree plus local-client sidecars. The
 * resulting descriptors point at the original bytes in place; reconciliation
 * lives in `db/local-directory-import.ts`.
 *
 * [COMP:files/local-directory-import]
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkspaceFile } from '@use-brian/core'

export const LOCAL_DIRECTORY_IMPORT_LIMIT = 100_000
export const LOCAL_DIRECTORY_METADATA_KEY = 'localDirectory'

export type LocalDirectoryFileDescriptor = {
  relativePath: string
  brainPath: string
  parentPath: string
  name: string
  title: string
  mime: string
  sizeBytes: number
  mtimeMs: number
  fingerprint: string
  storageUri: string
}

export type LocalDirectoryScan = {
  rootPath: string
  files: LocalDirectoryFileDescriptor[]
  fileCount: number
  totalBytes: number
  truncated: boolean
}

export type LocalDirectoryImportMetadata = {
  connectorInstanceId: string
  relativePath: string
  fingerprint: string
  readOnly: true
}

const EXTENSION_MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript',
  mjs: 'application/javascript', cjs: 'application/javascript', ts: 'application/typescript',
  tsx: 'application/typescript', jsx: 'text/jsx', py: 'text/x-python', rb: 'text/x-ruby',
  sh: 'text/x-shellscript', sql: 'application/sql', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip', gz: 'application/gzip', mp3: 'audio/mpeg',
  wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime',
}

export function inferLocalDirectoryMime(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase()
  return EXTENSION_MIME[ext] ?? 'application/octet-stream'
}

function posixRelative(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join('/')
}

function logicalPath(relativePath: string): string {
  return `/local/${relativePath}`
}

function parentOf(brainPath: string): string {
  const slash = brainPath.lastIndexOf('/')
  return slash <= 0 ? '/' : brainPath.slice(0, slash)
}

export function localDirectoryMetadata(file: Pick<WorkspaceFile, 'metadata'>): LocalDirectoryImportMetadata | null {
  const value = file.metadata?.[LOCAL_DIRECTORY_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.readOnly !== true ||
    typeof record.connectorInstanceId !== 'string' ||
    typeof record.relativePath !== 'string' ||
    typeof record.fingerprint !== 'string'
  ) return null
  const relativePath = record.relativePath
  if (!isSafeLocalStorageKey(relativePath)) return null
  return {
    connectorInstanceId: record.connectorInstanceId,
    relativePath,
    fingerprint: record.fingerprint,
    readOnly: true,
  }
}

export function isSafeLocalStorageKey(value: string): boolean {
  if (!value || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  const parts = value.replace(/\\/g, '/').split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

export function storageKeyForWorkspaceFile(file: Pick<WorkspaceFile, 'id' | 'workspaceId' | 'metadata'>): string {
  const imported = localDirectoryMetadata(file)
  return imported?.relativePath ?? `${file.workspaceId}/${file.id}`
}

export async function scanLocalDirectory(input: {
  rootPath: string
  workspaceId: string
  maxFiles?: number
}): Promise<LocalDirectoryScan> {
  const rootPath = await fs.realpath(path.resolve(input.rootPath))
  const rootStat = await fs.stat(rootPath)
  if (!rootStat.isDirectory()) throw new Error('Path is not a directory')
  await fs.access(rootPath, fs.constants.R_OK)

  const maxFiles = input.maxFiles ?? LOCAL_DIRECTORY_IMPORT_LIMIT
  const files: LocalDirectoryFileDescriptor[] = []
  const pending = [rootPath]
  let totalBytes = 0
  let truncated = false

  while (pending.length > 0 && !truncated) {
    const directory = pending.pop()!
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolutePath = path.join(directory, entry.name)
      const relativePath = posixRelative(rootPath, absolutePath)
      if (entry.isDirectory()) {
        // New Workspace File writes live at <root>/<workspace UUID>/<file UUID>.
        // Importing that subtree would duplicate Brian's own managed objects.
        if (relativePath === input.workspaceId) continue
        pending.push(absolutePath)
        continue
      }
      if (!entry.isFile() || entry.name.endsWith('.meta.json')) continue
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
      const stat = await fs.lstat(absolutePath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      const mtimeMs = Math.trunc(stat.mtimeMs)
      const brainPath = logicalPath(relativePath)
      files.push({
        relativePath,
        brainPath,
        parentPath: parentOf(brainPath),
        name: entry.name,
        title: entry.name,
        mime: inferLocalDirectoryMime(entry.name),
        sizeBytes: stat.size,
        mtimeMs,
        fingerprint: `${stat.size}:${mtimeMs}`,
        storageUri: pathToFileURL(absolutePath).href,
      })
      totalBytes += stat.size
    }
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { rootPath, files, fileCount: files.length, totalBytes, truncated }
}
