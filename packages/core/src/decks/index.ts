export { writeDeckPptx, type ResolvedDeckImage, type ResolvedImages } from './pptx-writer.js'
export { extractDeckStyle, parseThemeScheme } from './style-extract.js'
export { resolveDeckImages, assertSafePublicUrl, isPrivateAddress, type DeckImageReader } from './image-resolve.js'
export {
  createDeckTools,
  DECK_PPTX_MIME,
  type DeckRecord,
  type DeckStorePort,
  type DeckToolOptions,
} from './tools.js'
