/** Deterministic spreadsheet calculation and address helpers. [COMP:office/spreadsheet-model] */
import type { SpreadsheetCell, SpreadsheetSnapshot, SpreadsheetWorksheet } from './model.js'

export type SpreadsheetFormulaError = Exclude<SpreadsheetCell['error'], undefined>
export type SpreadsheetCalculationIssue = { sheetId: string; address: string; error: SpreadsheetFormulaError; message: string }

type Scalar = string | number | boolean | null
type Value = Scalar | Scalar[]
type Token = { kind: 'number' | 'string' | 'ref' | 'identifier' | 'operator' | 'left' | 'right' | 'comma' | 'colon'; value: string }

const ERROR_VALUES = new Set<SpreadsheetFormulaError>(['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!', '#CIRCULAR!'])

export function columnNameToIndex(name: string): number {
  let index = 0
  for (const character of name.toUpperCase()) index = index * 26 + character.charCodeAt(0) - 64
  return index
}

export function columnIndexToName(index: number): string {
  let value = Math.max(1, Math.floor(index))
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export function parseCellAddress(address: string): { column: number; row: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(address.trim())
  return match ? { column: columnNameToIndex(match[1]), row: Number(match[2]) } : null
}

export function normalizeCellAddress(address: string): string | null {
  const parsed = parseCellAddress(address)
  return parsed ? `${columnIndexToName(parsed.column)}${parsed.row}` : null
}

export function addressesInRange(range: string): string[] {
  const [leftRaw, rightRaw = leftRaw] = range.split(':')
  const left = parseCellAddress(leftRaw)
  const right = parseCellAddress(rightRaw)
  if (!left || !right) return []
  const result: string[] = []
  for (let row = Math.min(left.row, right.row); row <= Math.max(left.row, right.row); row += 1) {
    for (let column = Math.min(left.column, right.column); column <= Math.max(left.column, right.column); column += 1) result.push(`${columnIndexToName(column)}${row}`)
  }
  return result
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const rest = source.slice(index)
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) { index += whitespace[0].length; continue }
    const quotedRef = /^(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_. ]*))!\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})/.exec(rest)
    if (quotedRef) {
      const sheet = (quotedRef[1] ?? quotedRef[2]).replaceAll("''", "'")
      tokens.push({ kind: 'ref', value: `${sheet}!${quotedRef[3].toUpperCase()}${quotedRef[4]}` })
      index += quotedRef[0].length
      continue
    }
    const ref = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})/.exec(rest)
    if (ref) { tokens.push({ kind: 'ref', value: `${ref[1].toUpperCase()}${ref[2]}` }); index += ref[0].length; continue }
    const number = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/.exec(rest)
    if (number) { tokens.push({ kind: 'number', value: number[0] }); index += number[0].length; continue }
    if (rest[0] === '"') {
      let text = ''
      index += 1
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') { text += '"'; index += 2; continue }
        if (source[index] === '"') { index += 1; break }
        text += source[index]
        index += 1
      }
      tokens.push({ kind: 'string', value: text })
      continue
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest)
    if (identifier) { tokens.push({ kind: 'identifier', value: identifier[0].toUpperCase() }); index += identifier[0].length; continue }
    const pair = rest.slice(0, 2)
    if (['<=', '>=', '<>'].includes(pair)) { tokens.push({ kind: 'operator', value: pair }); index += 2; continue }
    const kind = rest[0] === '(' ? 'left' : rest[0] === ')' ? 'right' : rest[0] === ',' ? 'comma' : rest[0] === ':' ? 'colon' : '+-*/&=<>'.includes(rest[0]) ? 'operator' : null
    if (!kind) throw new FormulaFailure('#NAME?', `Unsupported formula token near ${rest.slice(0, 16)}`)
    tokens.push({ kind, value: rest[0] } as Token)
    index += 1
  }
  return tokens
}

class FormulaFailure extends Error {
  constructor(readonly error: SpreadsheetFormulaError, message: string) { super(message) }
}

function isError(value: Scalar): value is SpreadsheetFormulaError {
  return typeof value === 'string' && ERROR_VALUES.has(value as SpreadsheetFormulaError)
}

function scalar(value: Value): Scalar {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new FormulaFailure('#VALUE!', 'A range cannot be used as a scalar here')
    return value[0]
  }
  return value
}

function flatten(values: Value[]): Scalar[] {
  return values.flatMap((value) => Array.isArray(value) ? value : [value])
}

function excelSerialFromIso(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time / 86_400_000 + 25_569 : null
}

function toNumber(value: Scalar): number {
  if (isError(value)) throw new FormulaFailure(value, `Referenced cell contains ${value}`)
  if (value === null || value === '') return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  const date = excelSerialFromIso(value)
  const number = date ?? Number(value)
  if (!Number.isFinite(number)) throw new FormulaFailure('#VALUE!', `Cannot convert ${value} to a number`)
  return number
}

function truthy(value: Scalar): boolean {
  if (isError(value)) throw new FormulaFailure(value, `Referenced cell contains ${value}`)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return value !== null && value !== '' && value.toUpperCase() !== 'FALSE'
}

function compare(left: Scalar, right: Scalar, operator: string): boolean {
  if (operator === '=') return left === right || String(left ?? '') === String(right ?? '')
  if (operator === '<>') return !compare(left, right, '=')
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === '<') return left < right
    if (operator === '>') return left > right
    if (operator === '<=') return left <= right
    return left >= right
  }
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (operator === '<') return a < b
  if (operator === '>') return a > b
  if (operator === '<=') return a <= b
  return a >= b
}

class Parser {
  private index = 0
  constructor(
    private readonly tokens: Token[],
    private readonly currentRow: number,
    private readonly resolveReference: (reference: string) => Scalar,
  ) {}

  parse(): Value {
    const value = this.comparison()
    if (this.index !== this.tokens.length) throw new FormulaFailure('#VALUE!', 'Unexpected trailing formula content')
    return value
  }

  private peek(kind?: Token['kind'], value?: string): Token | undefined {
    const token = this.tokens[this.index]
    return token && (!kind || token.kind === kind) && (!value || token.value === value) ? token : undefined
  }

  private take(kind?: Token['kind'], value?: string): Token | undefined {
    const token = this.peek(kind, value)
    if (token) this.index += 1
    return token
  }

  private comparison(): Value {
    let left = this.concatenation()
    while (this.peek('operator') && ['=', '<>', '<', '>', '<=', '>='].includes(this.peek()!.value)) {
      const operator = this.take('operator')!.value
      left = compare(scalar(left), scalar(this.concatenation()), operator)
    }
    return left
  }

  private concatenation(): Value {
    let left = this.addition()
    while (this.take('operator', '&')) left = `${scalar(left) ?? ''}${scalar(this.addition()) ?? ''}`
    return left
  }

  private addition(): Value {
    let left = this.multiplication()
    while (this.peek('operator') && ['+', '-'].includes(this.peek()!.value)) {
      const operator = this.take('operator')!.value
      const right = this.multiplication()
      left = operator === '+' ? toNumber(scalar(left)) + toNumber(scalar(right)) : toNumber(scalar(left)) - toNumber(scalar(right))
    }
    return left
  }

  private multiplication(): Value {
    let left = this.unary()
    while (this.peek('operator') && ['*', '/'].includes(this.peek()!.value)) {
      const operator = this.take('operator')!.value
      const right = toNumber(scalar(this.unary()))
      if (operator === '/' && right === 0) throw new FormulaFailure('#DIV/0!', 'Division by zero')
      left = operator === '*' ? toNumber(scalar(left)) * right : toNumber(scalar(left)) / right
    }
    return left
  }

  private unary(): Value {
    if (this.take('operator', '-')) return -toNumber(scalar(this.unary()))
    if (this.take('operator', '+')) return toNumber(scalar(this.unary()))
    return this.primary()
  }

  private primary(): Value {
    const number = this.take('number')
    if (number) return Number(number.value)
    const string = this.take('string')
    if (string) return string.value
    const reference = this.take('ref')
    if (reference) {
      if (this.take('colon')) {
        const end = this.take('ref')
        if (!end) throw new FormulaFailure('#REF!', 'Range end is missing')
        return this.resolveRange(reference.value, end.value)
      }
      return this.resolveReference(reference.value)
    }
    const identifier = this.take('identifier')
    if (identifier) {
      if (identifier.value === 'TRUE') return true
      if (identifier.value === 'FALSE') return false
      if (!this.take('left')) throw new FormulaFailure('#NAME?', `Unknown name ${identifier.value}`)
      const args: Value[] = []
      if (!this.peek('right')) {
        do { args.push(this.comparison()) } while (this.take('comma'))
      }
      if (!this.take('right')) throw new FormulaFailure('#VALUE!', `Function ${identifier.value} is missing a closing parenthesis`)
      return this.functionValue(identifier.value, args)
    }
    if (this.take('left')) {
      const value = this.comparison()
      if (!this.take('right')) throw new FormulaFailure('#VALUE!', 'Closing parenthesis is missing')
      return value
    }
    throw new FormulaFailure('#VALUE!', 'Formula value is missing')
  }

  private resolveRange(start: string, end: string): Scalar[] {
    const split = (reference: string) => {
      const separator = reference.lastIndexOf('!')
      return separator >= 0 ? { sheet: reference.slice(0, separator), address: reference.slice(separator + 1) } : { sheet: '', address: reference }
    }
    const left = split(start)
    const right = split(end)
    const sheet = right.sheet || left.sheet
    if (left.sheet && right.sheet && left.sheet !== right.sheet) throw new FormulaFailure('#REF!', 'A range cannot span worksheets')
    const addresses = addressesInRange(`${left.address}:${right.address}`)
    if (!addresses.length) throw new FormulaFailure('#REF!', 'Invalid range')
    return addresses.map((address) => this.resolveReference(sheet ? `${sheet}!${address}` : address))
  }

  private functionValue(name: string, args: Value[]): Value {
    const values = flatten(args)
    if (name === 'IF') return truthy(scalar(args[0] ?? false)) ? (args[1] ?? true) : (args[2] ?? false)
    if (name === 'OR') return values.some(truthy)
    if (name === 'ROW') return this.currentRow
    if (name === 'ROUND') {
      const digits = Math.trunc(toNumber(scalar(args[1] ?? 0)))
      const factor = 10 ** digits
      return Math.round((toNumber(scalar(args[0] ?? 0)) + Number.EPSILON) * factor) / factor
    }
    if (name === 'COUNT') return values.filter((value) => typeof value === 'number').length
    if (name === 'SUM') return values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
    if (name === 'SUMPRODUCT') {
      const ranges = args.map((arg) => Array.isArray(arg) ? arg : [arg])
      const length = Math.max(0, ...ranges.map((range) => range.length))
      if (!ranges.length || ranges.some((range) => range.length !== length)) throw new FormulaFailure('#VALUE!', 'SUMPRODUCT ranges must have the same size')
      let total = 0
      for (let index = 0; index < length; index += 1) total += ranges.reduce((product, range) => product * toNumber(range[index]), 1)
      return total
    }
    throw new FormulaFailure('#NAME?', `Unsupported function ${name}`)
  }
}

function literalValue(cell: SpreadsheetCell | undefined): Scalar {
  if (!cell) return null
  if (cell.error) return cell.error
  if (cell.formula) return cell.calculatedValue ?? null
  return cell.value
}

export function recalculateSpreadsheet(snapshot: SpreadsheetSnapshot): { snapshot: SpreadsheetSnapshot; issues: SpreadsheetCalculationIssue[] } {
  const next = structuredClone(snapshot)
  const sheetsByName = new Map(next.worksheets.map((sheet) => [sheet.name.toLocaleLowerCase(), sheet]))
  const cellsBySheet = new Map(next.worksheets.map((sheet) => [sheet.id, new Map(sheet.cells.map((cell) => [cell.address, cell]))]))
  const visiting = new Set<string>()
  const finished = new Set<string>()
  const issues: SpreadsheetCalculationIssue[] = []

  const evaluate = (sheet: SpreadsheetWorksheet, cell: SpreadsheetCell): Scalar => {
    const key = `${sheet.id}:${cell.address}`
    if (!cell.formula) return literalValue(cell)
    if (finished.has(key)) return literalValue(cell)
    if (visiting.has(key)) throw new FormulaFailure('#CIRCULAR!', `Circular reference at ${sheet.name}!${cell.address}`)
    visiting.add(key)
    try {
      const address = parseCellAddress(cell.address)
      const parser = new Parser(tokenize(cell.formula.replace(/^=/, '')), address?.row ?? 1, (reference) => {
        const separator = reference.lastIndexOf('!')
        const targetSheet = separator >= 0 ? sheetsByName.get(reference.slice(0, separator).toLocaleLowerCase()) : sheet
        const targetAddress = normalizeCellAddress(separator >= 0 ? reference.slice(separator + 1) : reference)
        if (!targetSheet || !targetAddress) throw new FormulaFailure('#REF!', `Reference ${reference} was not found`)
        const target = cellsBySheet.get(targetSheet.id)?.get(targetAddress)
        return target?.formula ? evaluate(targetSheet, target) : literalValue(target)
      })
      const result = scalar(parser.parse())
      if (isError(result)) throw new FormulaFailure(result, `Formula returned ${result}`)
      cell.calculatedValue = result
      delete cell.error
      finished.add(key)
      return result
    } catch (cause) {
      const failure = cause instanceof FormulaFailure ? cause : new FormulaFailure('#VALUE!', cause instanceof Error ? cause.message : 'Formula evaluation failed')
      cell.calculatedValue = null
      cell.error = failure.error
      issues.push({ sheetId: sheet.id, address: cell.address, error: failure.error, message: failure.message })
      finished.add(key)
      return failure.error
    } finally {
      visiting.delete(key)
    }
  }

  for (const sheet of next.worksheets) for (const cell of sheet.cells) if (cell.formula) evaluate(sheet, cell)
  return { snapshot: next, issues }
}

export function spreadsheetCellDisplayValue(cell: SpreadsheetCell): string {
  if (cell.error) return cell.error
  const value = cell.formula ? cell.calculatedValue : cell.value
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (cell.valueType === 'date' && typeof value === 'string') {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return /^y{2,4}[-/]m{1,2}[-/]d{1,2}$/i.test(cell.numberFormat ?? '') ? date.toISOString().slice(0, 10) : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
  }
  if (typeof value === 'number' && cell.numberFormat) {
    const format = cell.numberFormat
    const tokenFormat = format
      .replace(/"[^"]*"/g, '')
      .replace(/\\./g, '')
      .replace(/\[[^\]]*\]/g, '')
    if (/[%]/.test(tokenFormat)) {
      const decimals = /\.(0+)/.exec(tokenFormat)?.[1].length ?? 0
      return `${(value * 100).toFixed(decimals)}%`
    }
    if (/[dmy]/i.test(tokenFormat)) {
      const date = new Date((value - 25_569) * 86_400_000)
      if (!Number.isNaN(date.getTime())) return /^y{2,4}[-/]m{1,2}[-/]d{1,2}$/i.test(tokenFormat) ? date.toISOString().slice(0, 10) : new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
    }
    const decimals = /\.(0+)/.exec(tokenFormat)?.[1].length ?? 0
    if (/[#0]/.test(tokenFormat)) {
      const numeric = tokenFormat.includes('#,##0')
        ? new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)
        : value.toFixed(decimals)
      const numericStart = format.search(/[0#?]/)
      const numericEnd = Math.max(format.lastIndexOf('0'), format.lastIndexOf('#'), format.lastIndexOf('?'))
      const literals = [...format.matchAll(/"([^"]*)"/g)]
      const prefix = literals.filter((match) => (match.index ?? 0) < numericStart).map((match) => match[1]).join('')
      const suffix = literals.filter((match) => (match.index ?? 0) > numericEnd).map((match) => match[1]).join('')
      return `${prefix}${numeric}${suffix}`
    }
  }
  return String(value)
}
