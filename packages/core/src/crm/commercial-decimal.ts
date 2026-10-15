/**
 * Exact decimal arithmetic for commercial amounts. Values are decimal strings;
 * arithmetic is BigInt over a shared scale. Rounding is half away from zero to
 * a declared number of minor units. No floating point touches an amount.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation
 *
 * [COMP:crm/invoice-preparation]
 */

type Scaled = { value: bigint; scale: number }

const DECIMAL = /^(-?)(\d{1,18})(?:\.(\d{1,12}))?$/

export class CrmDecimalError extends Error {
  readonly code = 'unsupported_monetary_value'
  constructor(message: string) {
    super(message)
    this.name = 'CrmDecimalError'
  }
}

function parse(text: string): Scaled {
  const match = DECIMAL.exec(text)
  if (!match) throw new CrmDecimalError(`"${text}" is not a supported decimal string`)
  const fraction = match[3] ?? ''
  const digits = BigInt(`${match[2]}${fraction}`)
  return { value: match[1] === '-' ? -digits : digits, scale: fraction.length }
}

function align(left: Scaled, right: Scaled): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale)
  return [left.value * 10n ** BigInt(scale - left.scale), right.value * 10n ** BigInt(scale - right.scale), scale]
}

function format(value: Scaled, places: number): string {
  const negative = value.value < 0n
  const absolute = (negative ? -value.value : value.value).toString().padStart(value.scale + 1, '0')
  const whole = value.scale ? absolute.slice(0, -value.scale) : absolute
  const fraction = value.scale ? absolute.slice(-value.scale) : ''
  const padded = (fraction + '0'.repeat(Math.max(0, places - fraction.length))).slice(0, places)
  const text = places ? `${whole}.${padded}` : whole
  return negative && /[1-9]/.test(text) ? `-${text}` : text
}

/** Round half away from zero to `places` fractional digits. */
function round(value: Scaled, places: number): Scaled {
  if (value.scale <= places) return { value: value.value * 10n ** BigInt(places - value.scale), scale: places }
  const divisor = 10n ** BigInt(value.scale - places)
  const negative = value.value < 0n
  const absolute = negative ? -value.value : value.value
  let quotient = absolute / divisor
  if ((absolute % divisor) * 2n >= divisor) quotient += 1n
  return { value: negative ? -quotient : quotient, scale: places }
}

export function crmDecimalAdd(left: string, right: string, places: number): string {
  const [a, b, scale] = align(parse(left), parse(right))
  return format(round({ value: a + b, scale }, places), places)
}

export function crmDecimalMultiply(left: string, right: string, places: number): string {
  const a = parse(left), b = parse(right)
  return format(round({ value: a.value * b.value, scale: a.scale + b.scale }, places), places)
}

export function crmDecimalRound(value: string, places: number): string {
  return format(round(parse(value), places), places)
}

export function crmDecimalCompare(left: string, right: string): number {
  const [a, b] = align(parse(left), parse(right))
  return a === b ? 0 : a < b ? -1 : 1
}

export function crmDecimalFractionDigits(value: string): number {
  return parse(value).scale
}

/** ISO 4217 minor units for supported currencies. An unlisted currency needs explicit configuration. */
export const CRM_CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  AED: 2, AUD: 2, BHD: 3, BRL: 2, CAD: 2, CHF: 2, CNY: 2, CZK: 2, DKK: 2, EUR: 2, GBP: 2, HKD: 2, IDR: 2,
  INR: 2, JPY: 0, KRW: 0, KWD: 3, MOP: 2, MXN: 2, MYR: 2, NOK: 2, NZD: 2, OMR: 3, PHP: 2, PLN: 2, SAR: 2,
  SEK: 2, SGD: 2, THB: 2, TWD: 2, USD: 2, VND: 0, ZAR: 2,
})

export function crmCurrencyMinorUnits(currency: string, configured?: number | null): number {
  if (configured !== undefined && configured !== null) {
    if (!Number.isInteger(configured) || configured < 0 || configured > 4) throw new CrmDecimalError('Minor units must be an integer from 0 to 4')
    return configured
  }
  const units = CRM_CURRENCY_MINOR_UNITS[currency]
  if (units === undefined) throw new CrmDecimalError(`Currency ${currency} needs explicit minor-unit configuration`)
  return units
}

export type CrmInvoiceLineInput = { description: string; quantity: string; unitPrice: string; dealId?: string | null }
export type CrmInvoiceTotals = {
  currency: string
  minorUnits: number
  lines: Array<CrmInvoiceLineInput & { amount: string }>
  subtotal: string
  taxRate: string
  taxAmount: string
  total: string
}

/**
 * Line-level rounding, subtotal addition, invoice-level tax rounding.
 * Quantities and unit prices carry at most six fractional digits; the tax rate
 * is a nonnegative fraction no greater than one.
 */
export function computeCrmInvoiceTotals(input: { currency: string; minorUnits?: number | null; lines: readonly CrmInvoiceLineInput[]; taxRate: string }): CrmInvoiceTotals {
  const minorUnits = crmCurrencyMinorUnits(input.currency, input.minorUnits)
  if (!input.lines.length) throw new CrmDecimalError('An invoice needs at least one line')
  for (const line of input.lines) {
    if (crmDecimalFractionDigits(line.quantity) > 6 || crmDecimalFractionDigits(line.unitPrice) > 6) {
      throw new CrmDecimalError('Quantities and unit prices allow at most six fractional digits')
    }
  }
  if (crmDecimalFractionDigits(input.taxRate) > 6 || crmDecimalCompare(input.taxRate, '0') < 0 || crmDecimalCompare(input.taxRate, '1') > 0) {
    throw new CrmDecimalError('A tax rate is a fraction from 0 to 1 with at most six fractional digits')
  }
  const lines = input.lines.map((line) => ({ ...line, amount: crmDecimalMultiply(line.quantity, line.unitPrice, minorUnits) }))
  const subtotal = lines.reduce((sum, line) => crmDecimalAdd(sum, line.amount, minorUnits), crmDecimalRound('0', minorUnits))
  const taxAmount = crmDecimalMultiply(subtotal, input.taxRate, minorUnits)
  return { currency: input.currency, minorUnits, lines, subtotal, taxRate: input.taxRate, taxAmount, total: crmDecimalAdd(subtotal, taxAmount, minorUnits) }
}
