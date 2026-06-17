import { describe, it, expect, vi } from 'vitest'
import { createGoogleSheetsTools, type GoogleSheetsApi } from '../base/google-sheets.js'
import { createGoogleDocsTools, type GoogleDocsApi } from '../base/google-docs.js'
import { createGoogleSlidesTools, type GoogleSlidesApi } from '../base/google-slides.js'
import type { ToolContext } from '../types.js'

const ctx: ToolContext = {
  userId: 'u1',
  assistantId: 'a1',
  sessionId: 's1',
  appId: 'test',
  channelType: 'web',
  channelId: 'c1',
  abortSignal: new AbortController().signal,
}

function sheetsApi(): GoogleSheetsApi {
  return {
    getSpreadsheetInfo: vi.fn(),
    readRange: vi.fn(),
    writeRange: vi.fn(),
    appendRows: vi.fn(),
    create: vi.fn().mockResolvedValue({
      spreadsheetId: 's-new',
      title: 'Budget',
      url: 'https://docs.google.com/spreadsheets/d/s-new/edit',
    }),
    format: vi.fn().mockResolvedValue({
      sheetId: 0,
      sheetTitle: 'Sheet1',
      applied: ['boldHeader', 'freezeRows=1', 'autoResizeColumns'],
    }),
    batchUpdate: vi.fn().mockResolvedValue({ requestCount: 1, replies: [{}] }),
  }
}

function docsApi(): GoogleDocsApi {
  return {
    getContent: vi.fn(),
    appendText: vi.fn(),
    replaceText: vi.fn(),
    create: vi.fn().mockResolvedValue({
      documentId: 'd-new',
      title: 'Notes',
      url: 'https://docs.google.com/document/d/d-new/edit',
    }),
  }
}

function slidesApi(): GoogleSlidesApi {
  return {
    getPresentationInfo: vi.fn(),
    getSlideContent: vi.fn(),
    getSlideThumbnail: vi.fn(),
    createSlide: vi.fn(),
    updateSlideContent: vi.fn(),
    insertImage: vi.fn(),
    deleteSlide: vi.fn(),
    reorderSlides: vi.fn(),
    duplicateSlide: vi.fn(),
    batchUpdate: vi.fn(),
    createPresentation: vi.fn().mockResolvedValue({
      presentationId: 'p-new',
      title: 'Deck',
      url: 'https://docs.google.com/presentation/d/p-new/edit',
    }),
  }
}

describe('[COMP:tools/google-sheets-create] googleSheetsCreate', () => {
  it('creates a spreadsheet and always prompts for confirmation', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const createTool = tools.find((t) => t.name === 'googleSheetsCreate')!
    expect(createTool).toBeDefined()
    expect(createTool.requiresConfirmation).toBe(true)
    // The tool always prompts regardless of authorizedFiles (newly-created
    // file has no ID to authorize yet).
    const shouldPrompt = await createTool.resolveConfirmation?.(ctx, { title: 'Budget' })
    expect(shouldPrompt).toBe(true)

    const result = await createTool.execute({ title: 'Budget' }, ctx)
    expect(api.create).toHaveBeenCalledWith('Budget')
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ spreadsheetId: 's-new', url: expect.stringContaining('s-new') })
  })
})

describe('[COMP:tools/google-sheets-format] googleSheetsFormat', () => {
  it('prompts for confirmation when the spreadsheet is not yet authorized, then calls api.format', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const formatTool = tools.find((t) => t.name === 'googleSheetsFormat')!
    expect(formatTool).toBeDefined()
    expect(formatTool.requiresConfirmation).toBe(true)

    const shouldPrompt = await formatTool.resolveConfirmation?.(ctx, { spreadsheetId: 's-new' })
    expect(shouldPrompt).toBe(true)

    const result = await formatTool.execute(
      { spreadsheetId: 's-new', boldHeader: true, freezeRows: 1, autoResizeColumns: true },
      ctx,
    )
    expect(api.format).toHaveBeenCalledWith('s-new', {
      sheetName: undefined,
      boldHeader: true,
      freezeRows: 1,
      freezeColumns: undefined,
      autoResizeColumns: true,
    })
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ applied: expect.arrayContaining(['boldHeader']) })
  })

  it('skips the confirmation prompt when the spreadsheet is already authorized', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [
      { id: 's-new', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', addedAt: '2026-01-01T00:00:00Z' },
    ])
    const formatTool = tools.find((t) => t.name === 'googleSheetsFormat')!
    const shouldPrompt = await formatTool.resolveConfirmation?.(ctx, { spreadsheetId: 's-new' })
    expect(shouldPrompt).toBe(false)
  })

  it('passes columnWidths, wrapText, and dataValidations through to the api', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const formatTool = tools.find((t) => t.name === 'googleSheetsFormat')!

    const result = await formatTool.execute(
      {
        spreadsheetId: 's-new',
        columnWidths: [
          { column: 'A', pixelSize: 160 },
          { column: 'B:D', pixelSize: 120 },
        ],
        wrapText: true,
        dataValidations: [
          { range: 'C2:C', values: ['VC', 'CVC', 'Strategic'] },
          { range: 'E2:E', values: ['To Contact', 'Contacted', 'Meeting Set', 'Passed'], strict: false },
        ],
      },
      ctx,
    )
    expect(api.format).toHaveBeenCalledWith('s-new', {
      sheetName: undefined,
      boldHeader: undefined,
      freezeRows: undefined,
      freezeColumns: undefined,
      autoResizeColumns: undefined,
      columnWidths: [
        { column: 'A', pixelSize: 160 },
        { column: 'B:D', pixelSize: 120 },
      ],
      wrapText: true,
      dataValidations: [
        { range: 'C2:C', values: ['VC', 'CVC', 'Strategic'] },
        { range: 'E2:E', values: ['To Contact', 'Contacted', 'Meeting Set', 'Passed'], strict: false },
      ],
    })
    expect(result.isError).toBeFalsy()
  })

  it('rejects input with no formatting options', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const formatTool = tools.find((t) => t.name === 'googleSheetsFormat')!
    const parsed = formatTool.inputSchema.safeParse({ spreadsheetId: 's-new' })
    expect(parsed.success).toBe(false)
  })

  it('rejects data validation rules with an empty values list', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const formatTool = tools.find((t) => t.name === 'googleSheetsFormat')!
    const parsed = formatTool.inputSchema.safeParse({
      spreadsheetId: 's-new',
      dataValidations: [{ range: 'C2:C', values: [] }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects invalid column letters in columnWidths', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const formatTool = tools.find((t) => t.name === 'googleSheetsFormat')!
    const parsed = formatTool.inputSchema.safeParse({
      spreadsheetId: 's-new',
      columnWidths: [{ column: 'A1', pixelSize: 100 }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('[COMP:tools/google-sheets-batch-update] googleSheetsBatchUpdate', () => {
  it('forwards non-destructive requests to the api', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const tool = tools.find((t) => t.name === 'googleSheetsBatchUpdate')!
    expect(tool).toBeDefined()
    expect(tool.requiresConfirmation).toBe(true)

    const requests = [{ mergeCells: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 }, mergeType: 'MERGE_ALL' } }]
    const result = await tool.execute(
      { spreadsheetId: 's-new', summary: 'Merge title row', requests },
      ctx,
    )
    expect(api.batchUpdate).toHaveBeenCalledWith('s-new', requests)
    expect(result.isError).toBeFalsy()
  })

  it('skips the prompt on authorized files when batch is non-destructive', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [
      { id: 's-new', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', addedAt: '2026-01-01T00:00:00Z' },
    ])
    const tool = tools.find((t) => t.name === 'googleSheetsBatchUpdate')!
    const shouldPrompt = await tool.resolveConfirmation?.(ctx, {
      spreadsheetId: 's-new',
      summary: 'Add chart',
      requests: [{ addChart: { chart: {} } }],
    })
    expect(shouldPrompt).toBe(false)
  })

  it('always prompts when the batch contains a destructive op, even on authorized files', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [
      { id: 's-new', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', addedAt: '2026-01-01T00:00:00Z' },
    ])
    const tool = tools.find((t) => t.name === 'googleSheetsBatchUpdate')!
    const shouldPrompt = await tool.resolveConfirmation?.(ctx, {
      spreadsheetId: 's-new',
      summary: 'Drop Archive tab',
      requests: [{ deleteSheet: { sheetId: 42 } }],
      allowDestructive: true,
    })
    expect(shouldPrompt).toBe(true)
  })

  it('blocks destructive ops without allowDestructive and does not call the api', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const tool = tools.find((t) => t.name === 'googleSheetsBatchUpdate')!

    const result = await tool.execute(
      {
        spreadsheetId: 's-new',
        summary: 'Delete old sheet',
        requests: [
          { mergeCells: { range: {}, mergeType: 'MERGE_ALL' } },
          { deleteSheet: { sheetId: 42 } },
          { deleteRange: { range: {}, shiftDimension: 'ROWS' } },
        ],
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('deleteSheet')
    expect(String(result.data)).toContain('deleteRange')
    expect(api.batchUpdate).not.toHaveBeenCalled()
  })

  it('allows destructive ops when allowDestructive is true', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const tool = tools.find((t) => t.name === 'googleSheetsBatchUpdate')!

    const result = await tool.execute(
      {
        spreadsheetId: 's-new',
        summary: 'Drop Archive tab',
        requests: [{ deleteSheet: { sheetId: 42 } }],
        allowDestructive: true,
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(api.batchUpdate).toHaveBeenCalled()
  })

  it('rejects an empty requests array at the schema level', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const tool = tools.find((t) => t.name === 'googleSheetsBatchUpdate')!
    const parsed = tool.inputSchema.safeParse({
      spreadsheetId: 's-new',
      summary: 'nothing',
      requests: [],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects input with missing summary', async () => {
    const api = sheetsApi()
    const tools = createGoogleSheetsTools(api, [])
    const tool = tools.find((t) => t.name === 'googleSheetsBatchUpdate')!
    const parsed = tool.inputSchema.safeParse({
      spreadsheetId: 's-new',
      requests: [{ mergeCells: {} }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('[COMP:tools/google-docs-create] googleDocsCreate', () => {
  it('creates a document and always prompts for confirmation', async () => {
    const api = docsApi()
    const tools = createGoogleDocsTools(api, [])
    const createTool = tools.find((t) => t.name === 'googleDocsCreate')!
    expect(createTool).toBeDefined()
    expect(createTool.requiresConfirmation).toBe(true)
    const shouldPrompt = await createTool.resolveConfirmation?.(ctx, { title: 'Notes' })
    expect(shouldPrompt).toBe(true)

    const result = await createTool.execute({ title: 'Notes' }, ctx)
    expect(api.create).toHaveBeenCalledWith('Notes')
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ documentId: 'd-new' })
  })
})

describe('[COMP:tools/google-slides-create-presentation] googleSlidesCreatePresentation', () => {
  it('creates a presentation and always prompts for confirmation', async () => {
    const api = slidesApi()
    const tools = createGoogleSlidesTools(api, [])
    const createTool = tools.find((t) => t.name === 'googleSlidesCreatePresentation')!
    expect(createTool).toBeDefined()
    expect(createTool.requiresConfirmation).toBe(true)
    const shouldPrompt = await createTool.resolveConfirmation?.(ctx, { title: 'Deck' })
    expect(shouldPrompt).toBe(true)

    const result = await createTool.execute({ title: 'Deck' }, ctx)
    expect(api.createPresentation).toHaveBeenCalledWith('Deck')
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ presentationId: 'p-new' })
  })
})
