/**
 * Unit tests for the Google Sheets tools.
 * Component tag: [COMP:tools/google-sheets].
 *
 * Verifies createGoogleSheetsTools: the seven-tool surface + flags, the
 * `Sheets error:` mapping, the authorized-file confirmation bypass, the
 * always-prompt create, the `format` refine (>=1 option required), and
 * the batchUpdate destructive-op gate — resolveConfirmation always
 * prompts on a destructive request and execute fail-closes unless
 * `allowDestructive` is set.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createGoogleSheetsTools,
  DESTRUCTIVE_SHEETS_REQUEST_TYPES,
  type GoogleSheetsApi,
} from '../google-sheets.js'
import type { AuthorizedFile } from '../google-drive.js'
import type { Tool, ToolContext } from '../../types.js'

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c-1',
  abortSignal: new AbortController().signal,
}

function stubApi(over: Partial<GoogleSheetsApi> = {}): GoogleSheetsApi {
  return {
    getSpreadsheetInfo: vi.fn().mockResolvedValue({ title: 'Book' }),
    readRange: vi.fn().mockResolvedValue([['a', 'b']]),
    writeRange: vi.fn().mockResolvedValue({ updatedCells: 2 }),
    appendRows: vi.fn().mockResolvedValue({ appended: 1 }),
    create: vi.fn().mockResolvedValue({ spreadsheetId: 's-new', title: 'New', url: 'http://x' }),
    format: vi.fn().mockResolvedValue({ ok: true }),
    batchUpdate: vi.fn().mockResolvedValue({ replies: [] }),
    ...over,
  }
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

const authFile: AuthorizedFile = {
  id: 's-ok',
  name: 'Picked',
  mimeType: 'application/vnd.google-apps.spreadsheet',
  addedAt: '2026-05-16T00:00:00Z',
}

describe('[COMP:tools/google-sheets] createGoogleSheetsTools', () => {
  it('exposes the seven sheets tools with read/write flags', () => {
    const tools = createGoogleSheetsTools(stubApi())
    expect(tools.map((t) => t.name)).toEqual([
      'googleSheetsGetInfo',
      'googleSheetsReadRange',
      'googleSheetsWriteRange',
      'googleSheetsAppendRows',
      'googleSheetsCreate',
      'googleSheetsFormat',
      'googleSheetsBatchUpdate',
    ])
    for (const r of ['googleSheetsGetInfo', 'googleSheetsReadRange']) {
      const tool = byName(tools, r)
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
    }
    for (const w of ['googleSheetsWriteRange', 'googleSheetsCreate', 'googleSheetsBatchUpdate']) {
      const tool = byName(tools, w)
      expect(tool.isReadOnly).toBe(false)
      expect(tool.requiresConfirmation).toBe(true)
    }
  })

  it('readRange forwards the id + range and getInfo maps errors to the Sheets prefix', async () => {
    const api = stubApi({ getSpreadsheetInfo: vi.fn().mockRejectedValue(new Error('gone')) })
    const tools = createGoogleSheetsTools(api)
    await byName(tools, 'googleSheetsReadRange').execute(
      { spreadsheetId: 's-1', range: 'Sheet1!A1:B2' },
      ctx,
    )
    expect(api.readRange).toHaveBeenCalledWith('s-1', 'Sheet1!A1:B2')
    const res = await byName(tools, 'googleSheetsGetInfo').execute({ spreadsheetId: 's-1' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toBe('Sheets error: gone')
  })

  it('writeRange skips the prompt for an authorized spreadsheet only', async () => {
    const tools = createGoogleSheetsTools(stubApi(), [authFile])
    const write = byName(tools, 'googleSheetsWriteRange')
    expect(await write.resolveConfirmation?.(ctx, { spreadsheetId: 's-other' })).toBe(true)
    expect(await write.resolveConfirmation?.(ctx, { spreadsheetId: 's-ok' })).toBe(false)
  })

  it('create always prompts even when the file list is fully authorized', async () => {
    const tools = createGoogleSheetsTools(stubApi(), [authFile])
    expect(
      await byName(tools, 'googleSheetsCreate').resolveConfirmation?.(ctx, { title: 'Q3' }),
    ).toBe(true)
  })

  it('format requires at least one formatting option', () => {
    const tools = createGoogleSheetsTools(stubApi())
    const schema = byName(tools, 'googleSheetsFormat').inputSchema
    expect(schema.safeParse({ spreadsheetId: 's-1' }).success).toBe(false)
    expect(schema.safeParse({ spreadsheetId: 's-1', boldHeader: true }).success).toBe(true)
  })

  it('batchUpdate always prompts when the batch contains a destructive request', async () => {
    const tools = createGoogleSheetsTools(stubApi(), [authFile])
    const batch = byName(tools, 'googleSheetsBatchUpdate')
    // authorized + non-destructive → bypass
    expect(
      await batch.resolveConfirmation?.(ctx, {
        spreadsheetId: 's-ok',
        requests: [{ mergeCells: {} }],
      }),
    ).toBe(false)
    // authorized but destructive → still prompt
    expect(
      await batch.resolveConfirmation?.(ctx, {
        spreadsheetId: 's-ok',
        requests: [{ deleteSheet: {} }],
      }),
    ).toBe(true)
    // un-authorized → prompt
    expect(
      await batch.resolveConfirmation?.(ctx, {
        spreadsheetId: 's-other',
        requests: [{ mergeCells: {} }],
      }),
    ).toBe(true)
  })

  it('batchUpdate fail-closes a destructive batch unless allowDestructive is set', async () => {
    const api = stubApi()
    const tools = createGoogleSheetsTools(api)
    const batch = byName(tools, 'googleSheetsBatchUpdate')

    const blocked = await batch.execute(
      { spreadsheetId: 's-1', summary: 'drop a tab', requests: [{ deleteSheet: {} }] },
      ctx,
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.data).toContain('destructive ops (deleteSheet)')
    expect(api.batchUpdate).not.toHaveBeenCalled()

    const allowed = await batch.execute(
      {
        spreadsheetId: 's-1',
        summary: 'drop a tab',
        requests: [{ deleteSheet: {} }],
        allowDestructive: true,
      },
      ctx,
    )
    expect(allowed.isError).toBeFalsy()
    expect(api.batchUpdate).toHaveBeenCalledWith('s-1', [{ deleteSheet: {} }])
  })

  it('lists the destructive request types so callers stay in sync', () => {
    expect(DESTRUCTIVE_SHEETS_REQUEST_TYPES).toContain('deleteSheet')
    expect(DESTRUCTIVE_SHEETS_REQUEST_TYPES).toContain('deleteProtectedRange')
  })
})
