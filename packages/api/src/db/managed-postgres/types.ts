/** [COMP:platform/managed-postgres] Minimal client shapes the runtime needs. */
import type { ManagedClientConfig } from './environment.js'

export interface ManagedQueryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
}

export interface ManagedClient extends ManagedQueryable {
  connect(): Promise<unknown>
  end(): Promise<void>
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'end', listener: () => void): unknown
  removeAllListeners(event?: 'error' | 'end'): unknown
}

export type ManagedClientConstructor = new (config: ManagedClientConfig) => ManagedClient
