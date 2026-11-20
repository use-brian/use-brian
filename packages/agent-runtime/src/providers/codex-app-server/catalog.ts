import {
  ModelListResponseSchema,
  type CodexModelProtocol,
  type ModelListResponse,
} from './protocol.js'
import { CodexProtocolError, type CodexRpcPeer } from './rpc.js'

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_PAGES = 20
const DEFAULT_MAX_MODELS = 1_000

export type CodexCatalogModel = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  inputModalities: readonly ('text' | 'image' | 'audio')[]
  defaultReasoningEffort: string
  supportedReasoningEfforts: ReadonlyArray<{
    reasoningEffort: string
    description: string
  }>
}

export type CodexModelCatalog = {
  models: readonly CodexCatalogModel[]
  availableModelIds: ReadonlySet<string>
  defaultModelId: string | null
}

export type ListCodexModelsOptions = {
  includeHidden?: boolean
  pageSize?: number
  maxPages?: number
  maxModels?: number
}

export class CodexCatalogClient {
  readonly #rpc: CodexRpcPeer

  constructor(rpc: CodexRpcPeer) {
    this.#rpc = rpc
  }

  async listModels(options: ListCodexModelsOptions = {}): Promise<CodexModelCatalog> {
    const pageSize = positiveInteger(options.pageSize, DEFAULT_PAGE_SIZE, 'pageSize')
    const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES, 'maxPages')
    const maxModels = positiveInteger(options.maxModels, DEFAULT_MAX_MODELS, 'maxModels')
    if (pageSize > 250) throw new TypeError('pageSize cannot exceed 250')

    const includeHidden = options.includeHidden === true
    const cursors = new Set<string>()
    const byModel = new Map<string, CodexCatalogModel>()
    let cursor: string | null = null
    let pages = 0

    do {
      if (pages >= maxPages) {
        throw new CodexProtocolError(`Codex model catalog exceeded ${maxPages} pages`)
      }
      pages++

      const response: ModelListResponse = await this.#rpc.request(
        'model/list',
        {
          cursor,
          includeHidden,
          limit: pageSize,
        },
        ModelListResponseSchema,
      )

      for (const item of response.data) {
        if (!includeHidden && item.hidden) continue
        const model = normalizeModel(item)
        if (byModel.has(model.model)) {
          throw new CodexProtocolError(
            `Codex model catalog returned duplicate model id: ${model.model}`,
          )
        }
        byModel.set(model.model, model)
        if (byModel.size > maxModels) {
          throw new CodexProtocolError(`Codex model catalog exceeded ${maxModels} models`)
        }
      }

      cursor = response.nextCursor ?? null
      if (cursor) {
        if (cursors.has(cursor)) {
          throw new CodexProtocolError('Codex model catalog repeated a pagination cursor')
        }
        cursors.add(cursor)
      }
    } while (cursor)

    const models = [...byModel.values()]
    const defaultModels = models.filter((model) => model.isDefault)
    if (defaultModels.length > 1) {
      throw new CodexProtocolError('Codex model catalog returned multiple default models')
    }

    return {
      models,
      availableModelIds: new Set(models.map((model) => model.model)),
      defaultModelId: defaultModels[0]?.model ?? null,
    }
  }
}

function normalizeModel(model: CodexModelProtocol): CodexCatalogModel {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    isDefault: model.isDefault,
    inputModalities: [...(model.inputModalities ?? ['text', 'image'])],
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
      reasoningEffort: effort.reasoningEffort,
      description: effort.description,
    })),
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return resolved
}
