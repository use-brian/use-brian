// Ambient type declarations for the doc-parsing libraries used by parsers.ts.
// Neither ships its own types and neither has a DefinitelyTyped package, so we
// declare just the surface we call. (turndown itself is typed via
// @types/turndown.)

declare module 'mammoth' {
  interface MammothInput {
    buffer?: Buffer
    path?: string
    arrayBuffer?: ArrayBuffer
  }
  interface MammothMessage {
    type: string
    message: string
  }
  interface MammothResult {
    value: string
    messages: MammothMessage[]
  }
  export function convertToHtml(input: MammothInput, options?: unknown): Promise<MammothResult>
  export function extractRawText(input: MammothInput): Promise<MammothResult>
  const mammoth: {
    convertToHtml: typeof convertToHtml
    extractRawText: typeof extractRawText
  }
  export default mammoth
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  type GfmPlugin = (service: TurndownService) => void
  export const gfm: GfmPlugin
  export const tables: GfmPlugin
  export const strikethrough: GfmPlugin
}
