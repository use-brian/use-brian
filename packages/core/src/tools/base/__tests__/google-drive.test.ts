/**
 * Unit tests for the Google Drive tools factory.
 * Component tag: [COMP:tools/google-drive].
 *
 * The three read tools work at both access levels: Google constrains a
 * `drive.file` grant to Picker-selected / app-created files, while a customer
 * BYO `drive.readonly` grant broadens the same calls to full-Drive read.
 * Writes remain withheld from this factory's returned surface.
 */

import { describe, it, expect, vi } from 'vitest'
import { createGoogleDriveTools, type GoogleDriveApi } from '../google-drive.js'
import type { AuthorizedFile } from '../google-drive.js'

function stubApi(): GoogleDriveApi {
  return {
    listFiles: vi.fn(),
    getFile: vi.fn(),
    getFileContent: vi.fn(),
    createFile: vi.fn(),
    updateFile: vi.fn(),
  }
}

describe('[COMP:tools/google-drive] createGoogleDriveTools', () => {
  it('returns the live search/read surface and withholds Drive writes', () => {
    expect(createGoogleDriveTools(stubApi()).map((tool) => tool.name)).toEqual([
      'googleDriveListFiles',
      'googleDriveGetFile',
      'googleDriveGetFileContent',
    ])
  })

  it('keeps the same read surface when an authorized-files list is supplied', () => {
    const authorized: AuthorizedFile[] = [
      { id: 'f-1', name: 'Doc', mimeType: 'application/pdf', addedAt: '2026-05-16T00:00:00Z' },
    ]
    expect(createGoogleDriveTools(stubApi(), authorized).map((tool) => tool.name)).toEqual([
      'googleDriveListFiles',
      'googleDriveGetFile',
      'googleDriveGetFileContent',
    ])
  })
})
