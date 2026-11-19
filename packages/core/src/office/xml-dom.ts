/**
 * The Office XML DOM (linkedom), loaded on the first Office XML parse instead
 * of with the Office modules (M4 step 5, D13). The loader is synchronous so
 * the synchronous parsers (`parseSimpleSpreadsheetTableXml`, the PPTX and
 * XLSX import helpers) keep their signatures; it resolves linkedom's CommonJS
 * build, the one instance every Office parser shares. A load failure is
 * `ImplementationUnavailableError` (nothing parsed, retryable), never a
 * malformed-document verdict.
 */
import { createRequire } from 'node:module'
import { ImplementationUnavailableError } from '@use-brian/agent-runtime/tools/lazy-implementation.js'

type Linkedom = typeof import('linkedom')

const requireLinkedom = createRequire(import.meta.url)
let linkedom: Linkedom | undefined

/** The linkedom `DOMParser` class, loading linkedom on first use. */
export function officeXmlDomParser(): Linkedom['DOMParser'] {
  if (!linkedom) {
    try {
      linkedom = requireLinkedom('linkedom') as Linkedom
    } catch (cause) {
      console.error('[lazy] implementation The Office XML parser (linkedom) failed to load:', cause)
      throw new ImplementationUnavailableError('The Office XML parser (linkedom)', { cause })
    }
  }
  return linkedom.DOMParser
}
