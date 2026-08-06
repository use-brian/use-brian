// Ambient type declaration for `turndown-plugin-gfm`, used by html.ts. The
// package ships no types and has no DefinitelyTyped entry, so we declare just
// the surface we call. (turndown itself is typed via @types/turndown.)
//
// The Office formats moved to @firecrawl/anydoc and took mammoth's declaration
// with them; HTML is not an AnyDoc format, so this one stays.

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  type GfmPlugin = (service: TurndownService) => void
  export const gfm: GfmPlugin
  export const tables: GfmPlugin
  export const strikethrough: GfmPlugin
}
