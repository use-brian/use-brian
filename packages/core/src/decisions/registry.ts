/** Injected decision-adapter registry. [COMP:decisions/registry] */

import type { DecisionProvider } from './types.js'

export type DecisionAdapterFactory<Config = unknown> = (config: Config) => DecisionProvider

export class DecisionAdapterRegistry {
  readonly #factories = new Map<string, DecisionAdapterFactory<unknown>>()

  register<Config>(adapterId: string, factory: DecisionAdapterFactory<Config>): this {
    const id = adapterId.trim()
    if (!id) throw new Error('decision adapter id must not be empty')
    if (this.#factories.has(id)) throw new Error(`decision adapter '${id}' is already registered`)
    this.#factories.set(id, factory as DecisionAdapterFactory<unknown>)
    return this
  }

  has(adapterId: string): boolean {
    return this.#factories.has(adapterId)
  }

  create<Config>(adapterId: string, config: Config): DecisionProvider {
    const factory = this.#factories.get(adapterId)
    if (!factory) throw new Error(`decision adapter '${adapterId}' is not registered`)
    return factory(config)
  }

  ids(): readonly string[] {
    return [...this.#factories.keys()]
  }
}
