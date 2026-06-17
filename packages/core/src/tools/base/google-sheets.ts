/**
 * Google Sheets tools — get spreadsheet info, read/write ranges, append rows.
 *
 * Read tools are concurrency-safe; write tools require confirmation.
 * The `api` callback is injected by the API layer so core stays
 * free of network/OAuth deps.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import type { AuthorizedFile } from './google-drive.js'

export type GoogleSheetsApi = {
  getSpreadsheetInfo(spreadsheetId: string): Promise<unknown>
  readRange(spreadsheetId: string, range: string): Promise<unknown>
  writeRange(spreadsheetId: string, range: string, values: string[][]): Promise<unknown>
  appendRows(spreadsheetId: string, range: string, values: string[][]): Promise<unknown>
  create(title: string): Promise<{ spreadsheetId: string; title: string; url: string }>
  format(
    spreadsheetId: string,
    opts: {
      sheetName?: string
      boldHeader?: boolean
      freezeRows?: number
      freezeColumns?: number
      autoResizeColumns?: boolean
      columnWidths?: Array<{ column: string; pixelSize: number }>
      wrapText?: boolean | { range: string }
      dataValidations?: Array<{
        range: string
        values: string[]
        strict?: boolean
      }>
    },
  ): Promise<unknown>
  batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<unknown>
}

/**
 * Request kinds that destroy or remove user data / guardrails. These require
 * the caller to pass `allowDestructive: true` and always prompt the user for
 * confirmation — the authorized-files bypass does NOT apply.
 */
export const DESTRUCTIVE_SHEETS_REQUEST_TYPES = [
  'deleteSheet',
  'deleteRange',
  'deleteDimension',
  'deleteDuplicates',
  'deleteEmbeddedObject',
  'deleteNamedRange',
  'deleteProtectedRange',
  'deleteDeveloperMetadata',
] as const

function findDestructiveRequestTypes(requests: Array<Record<string, unknown>>): string[] {
  const hits = new Set<string>()
  for (const req of requests) {
    for (const key of Object.keys(req)) {
      if ((DESTRUCTIVE_SHEETS_REQUEST_TYPES as readonly string[]).includes(key)) {
        hits.add(key)
      }
    }
  }
  return [...hits]
}

function isAuthorized(id: string | undefined, authorized: AuthorizedFile[]): boolean {
  if (!id) return false
  return authorized.some((f) => f.id === id)
}

export function createGoogleSheetsTools(api: GoogleSheetsApi, authorizedFiles: AuthorizedFile[] = []): Tool[] {
  const getInfo = buildTool({
    name: 'googleSheetsGetInfo',
    description:
      'Get metadata for a Google Sheets spreadsheet — title, sheet names, and dimensions. ' +
      'Use this to discover available sheets before reading data.',
    inputSchema: z.object({
      spreadsheetId: z.string().describe('The Google Sheets spreadsheet ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getSpreadsheetInfo(input.spreadsheetId)
        return { data }
      } catch (err) {
        return { data: `Sheets error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const readRange = buildTool({
    name: 'googleSheetsReadRange',
    description:
      'Read a range of cells from a Google Sheets spreadsheet. ' +
      'Use A1 notation for the range (e.g. "Sheet1!A1:D10", "A:A", "1:1"). ' +
      'Returns a 2D array of cell values.',
    inputSchema: z.object({
      spreadsheetId: z.string().describe('The Google Sheets spreadsheet ID.'),
      range: z.string().describe('A1 notation range (e.g. "Sheet1!A1:D10").'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.readRange(input.spreadsheetId, input.range)
        return { data }
      } catch (err) {
        return { data: `Sheets error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const writeRange = buildTool({
    name: 'googleSheetsWriteRange',
    description:
      'Write values to a range in a Google Sheets spreadsheet. Overwrites existing data in the range. ' +
      'Values are interpreted as if typed by a user (formulas, dates, numbers auto-detected). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the spreadsheet is already in their authorized files list.',
    inputSchema: z.object({
      spreadsheetId: z.string().describe('The Google Sheets spreadsheet ID.'),
      range: z.string().describe('A1 notation range to write to (e.g. "Sheet1!A1:C3").'),
      values: z.array(z.array(z.string())).describe('2D array of cell values. Each inner array is a row.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { spreadsheetId?: string })?.spreadsheetId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.writeRange(input.spreadsheetId, input.range, input.values)
        return { data }
      } catch (err) {
        return { data: `Sheets error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const appendRows = buildTool({
    name: 'googleSheetsAppendRows',
    description:
      'Append rows to the end of a table in a Google Sheets spreadsheet. ' +
      'Finds the last row of existing data in the range and appends below it. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the spreadsheet is already in their authorized files list.',
    inputSchema: z.object({
      spreadsheetId: z.string().describe('The Google Sheets spreadsheet ID.'),
      range: z.string().describe('A1 notation range identifying the table (e.g. "Sheet1!A:D").'),
      values: z.array(z.array(z.string())).describe('2D array of row values to append.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { spreadsheetId?: string })?.spreadsheetId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.appendRows(input.spreadsheetId, input.range, input.values)
        return { data }
      } catch (err) {
        return { data: `Sheets error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const create = buildTool({
    name: 'googleSheetsCreate',
    description:
      'Create a new, empty Google Sheets spreadsheet with the given title. ' +
      'Returns the spreadsheet ID and URL. After creation, the file is auto-added ' +
      'to the user\'s authorized files so subsequent writes (googleSheetsWriteRange, ' +
      'googleSheetsAppendRows) do not re-prompt. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt for this initial create.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Spreadsheet title (e.g. "Budget 2026").'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,

    // Newly-created files have no ID yet, so authorized-file bypass can't
    // apply. Always prompt for the create itself. The api-layer callback
    // appends the returned ID to authorizedFiles post-creation so follow-up
    // edits skip the prompt.
    async resolveConfirmation() {
      return true
    },

    async execute(input) {
      try {
        const data = await api.create(input.title)
        return { data }
      } catch (err) {
        return { data: `Sheets error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const format = buildTool({
    name: 'googleSheetsFormat',
    description:
      'Apply visual formatting and data validation to a Google Sheets spreadsheet. ' +
      'Supports: bolding the header, freezing rows/columns, auto-resizing columns, ' +
      'setting per-column pixel widths, enabling text wrap, and attaching dropdown ' +
      '(ONE_OF_LIST / enum) data validation to ranges. ' +
      'Use this after writing data to make the sheet look polished and constrain inputs. ' +
      'Specify at least one formatting option. Omit `sheetName` to format the first sheet tab. ' +
      'For structured tables, prefer `columnWidths` + `wrapText: true` over `autoResizeColumns` — ' +
      'autoResize produces uneven widths; explicit widths + wrap produce consistent layout. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the spreadsheet is already in their authorized files list.',
    inputSchema: z
      .object({
        spreadsheetId: z.string().describe('The Google Sheets spreadsheet ID.'),
        sheetName: z
          .string()
          .optional()
          .describe('Name of the sheet tab to format. Defaults to the first sheet.'),
        boldHeader: z
          .boolean()
          .optional()
          .describe('Bold row 1 (the header row).'),
        freezeRows: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Number of rows to freeze from the top. Use 1 to freeze just the header.'),
        freezeColumns: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Number of columns to freeze from the left.'),
        autoResizeColumns: z
          .boolean()
          .optional()
          .describe('Auto-resize all columns to fit their contents. Runs before columnWidths.'),
        columnWidths: z
          .array(
            z.object({
              column: z
                .string()
                .regex(/^[A-Za-z]+(?::[A-Za-z]+)?$/)
                .describe('Column letter or inclusive range: "A", "AA", "A:C".'),
              pixelSize: z
                .number()
                .int()
                .min(20)
                .max(2000)
                .describe('Column width in pixels (20–2000).'),
            }),
          )
          .optional()
          .describe(
            'Explicit pixel widths per column. Applied after autoResizeColumns so these override.',
          ),
        wrapText: z
          .union([
            z.boolean(),
            z.object({
              range: z
                .string()
                .describe('A1 range within the sheet, e.g. "A1:Z100" or "B:B".'),
            }),
          ])
          .optional()
          .describe(
            'Enable text wrapping. `true` wraps the whole sheet grid; `{ range }` wraps a specific A1 range.',
          ),
        dataValidations: z
          .array(
            z.object({
              range: z
                .string()
                .describe('A1 range to validate, e.g. "C2:C" for all of column C from row 2.'),
              values: z
                .array(z.string().min(1))
                .min(1)
                .describe('Allowed values for the dropdown (enum list).'),
              strict: z
                .boolean()
                .optional()
                .describe('Reject non-matching input. Default true. Set false to warn only.'),
            }),
          )
          .optional()
          .describe(
            'Dropdown (ONE_OF_LIST) data validation rules. Use this for enum-like columns (status, type, category).',
          ),
      })
      .refine(
        (v) =>
          v.boldHeader ||
          v.freezeRows !== undefined ||
          v.freezeColumns !== undefined ||
          v.autoResizeColumns ||
          (v.columnWidths && v.columnWidths.length > 0) ||
          v.wrapText !== undefined ||
          (v.dataValidations && v.dataValidations.length > 0),
        { message: 'Specify at least one formatting option.' },
      ),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { spreadsheetId?: string })?.spreadsheetId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.format(input.spreadsheetId, {
          sheetName: input.sheetName,
          boldHeader: input.boldHeader,
          freezeRows: input.freezeRows,
          freezeColumns: input.freezeColumns,
          autoResizeColumns: input.autoResizeColumns,
          columnWidths: input.columnWidths,
          wrapText: input.wrapText,
          dataValidations: input.dataValidations,
        })
        return { data }
      } catch (err) {
        return { data: `Sheets error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const batchUpdate = buildTool({
    name: 'googleSheetsBatchUpdate',
    description:
      'Escape hatch for the full Google Sheets API. Forwards raw `requests` to ' +
      '`spreadsheets.batchUpdate` — use this for anything the typed sheets tools ' +
      'do not cover: charts (addChart), pivot tables (updateCells with pivotTable), ' +
      'conditional formatting (addConditionalFormatRule), merged cells (mergeCells), ' +
      'borders (updateBorders), basic/filter views (setBasicFilter, addFilterView), ' +
      'protected ranges (addProtectedRange), banding (addBanding), named ranges ' +
      '(addNamedRange), inserting/appending rows or columns (insertDimension, ' +
      'appendDimension), cell-level formats (updateCells, repeatCell), copy/paste ' +
      '(copyPaste, cutPaste), find/replace (findReplace), and more. ' +
      'See https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request#Request ' +
      'for the exhaustive schema — each request is a single-key object whose key is ' +
      'the request type and value is that request\'s payload. ' +
      'Prefer the typed tools (googleSheetsFormat, googleSheetsWriteRange, ' +
      'googleSheetsAppendRows) when they fit; reach for this tool only for capabilities ' +
      'those cannot express. ' +
      'REQUIRED: `summary` — a short, human-readable description of what this batch does. ' +
      'It is shown verbatim in the user\'s Approve/Deny prompt; the user decides based on it. ' +
      'Destructive request types (deleteSheet, deleteRange, deleteDimension, deleteDuplicates, ' +
      'deleteEmbeddedObject, deleteNamedRange, deleteProtectedRange, deleteDeveloperMetadata) ' +
      'require `allowDestructive: true` and always prompt (authorized-file bypass does not apply). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt unless the spreadsheet ' +
      'is already in their authorized files list and the batch contains no destructive ops.',
    inputSchema: z.object({
      spreadsheetId: z.string().describe('The Google Sheets spreadsheet ID.'),
      summary: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'One-line human-readable summary of the batch (shown in the approval prompt). ' +
            'Example: "Add revenue bar chart to Summary sheet and merge title cells A1:D1".',
        ),
      requests: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe(
          'Array of Sheets API Request objects. Each entry must be a single-key object ' +
            'whose key names the request type (e.g. `{ addChart: { ... } }`, ' +
            '`{ mergeCells: { ... } }`, `{ repeatCell: { ... } }`).',
        ),
      allowDestructive: z
        .boolean()
        .optional()
        .describe(
          'Required when the batch contains any destructive request type (deleteSheet, ' +
            'deleteRange, deleteDimension, deleteDuplicates, deleteEmbeddedObject, ' +
            'deleteNamedRange, deleteProtectedRange, deleteDeveloperMetadata). ' +
            'Omit for non-destructive batches.',
        ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async resolveConfirmation(_context, input) {
      const i = input as {
        spreadsheetId?: string
        allowDestructive?: boolean
        requests?: Array<Record<string, unknown>>
      }
      const hasDestructive = i.requests
        ? findDestructiveRequestTypes(i.requests).length > 0
        : false
      if (hasDestructive || i.allowDestructive) return true
      return !isAuthorized(i.spreadsheetId, authorizedFiles)
    },

    async execute(input) {
      try {
        const destructive = findDestructiveRequestTypes(input.requests)
        if (destructive.length > 0 && !input.allowDestructive) {
          return {
            data:
              `Sheets error: request contains destructive ops (${destructive.join(', ')}). ` +
              'Set `allowDestructive: true` to proceed; these changes cannot be undone.',
            isError: true,
          }
        }
        const data = await api.batchUpdate(input.spreadsheetId, input.requests)
        return { data }
      } catch (err) {
        return {
          data: `Sheets error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })

  return [getInfo, readRange, writeRange, appendRows, create, format, batchUpdate]
}
