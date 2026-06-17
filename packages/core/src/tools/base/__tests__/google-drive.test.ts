/**
 * Unit tests for the Google Drive tools factory.
 * Component tag: [COMP:tools/google-drive].
 *
 * The Drive-file tools (list/get/read/create/update) are built inside
 * createGoogleDriveTools but deliberately NOT returned — they require
 * the restricted `drive.readonly` / `drive.file` scopes that are gated
 * behind a CASA audit (see google-drive.ts Phase 1.5 / Phase 2 notes).
 * This is a tripwire: when the surface is activated, the empty-array
 * assertion fails loudly, forcing the OFFICIAL_CONNECTOR_TOOLS update.
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
  it('withholds the Drive tool surface — Phase 2, pending CASA audit', () => {
    expect(createGoogleDriveTools(stubApi())).toEqual([])
  })

  it('accepts an authorized-files list without exposing any tools', () => {
    const authorized: AuthorizedFile[] = [
      { id: 'f-1', name: 'Doc', mimeType: 'application/pdf', addedAt: '2026-05-16T00:00:00Z' },
    ]
    expect(createGoogleDriveTools(stubApi(), authorized)).toEqual([])
  })
})
