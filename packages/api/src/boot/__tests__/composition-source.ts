/**
 * The open boot composition as one ordered source text, for source-anchor
 * tests that used to read the single-function `boot.ts`.
 *
 * `bootOpenApi` (packages/api/src/boot.ts) calls its register modules in a
 * fixed order; this inlines each `boot/<step>.register.ts` source right after
 * the line of `boot.ts` that calls it, so text order is execution order and an
 * order assertion (a public mount before the first bare `/api` guard) means
 * what it meant against the old inline body. Throws when a called register
 * function has no matching `./boot/<step>.register.js` import, so a renamed
 * step cannot silently drop out of the anchors.
 */
import { readFileSync } from 'node:fs'

const BOOT = new URL('../../boot.ts', import.meta.url)

/** Register steps in call order: `[functionName, moduleFile]`. */
export function bootRegisterOrder(source = readFileSync(BOOT, 'utf8')): Array<[string, string]> {
  const modules = new Map<string, string>()
  for (const m of source.matchAll(/import \{ (register\w+) \} from '\.\/boot\/([\w-]+\.register)\.js'/g)) modules.set(m[1], m[2])
  const body = source.slice(source.indexOf('export async function bootOpenApi('))
  const order: Array<[string, string]> = []
  for (const m of body.matchAll(/\b(register\w+)\((?:root|s\d+)\)/g)) {
    const file = modules.get(m[1])
    if (!file) throw new Error(`boot.ts calls ${m[1]} without a ./boot/<step>.register.js import`)
    order.push([m[1], file])
  }
  return order
}

/** boot.ts with every register module's source inlined at its call site. */
export function bootCompositionSource(): string {
  const source = readFileSync(BOOT, 'utf8')
  const files = new Map(bootRegisterOrder(source).map(([fn, file]) => [fn, file]))
  return source.split('\n').flatMap((line) => {
    const call = /\b(register\w+)\((?:root|s\d+)\)/.exec(line)
    const file = call && files.get(call[1])
    if (!file || line.trimStart().startsWith('import')) return [line]
    return [line, readFileSync(new URL(`../${file}.ts`, import.meta.url), 'utf8')]
  }).join('\n')
}
