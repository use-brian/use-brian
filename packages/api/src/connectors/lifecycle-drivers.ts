import type { ConnectorInstance } from '../db/connector-instance-store.js'

export type ConnectorLifecycleTool = {
  name: string
  description: string
}

/** Provider-specific network behavior stays outside the common lifecycle. */
export type ConnectorLifecycleDriver = {
  discoverTools?: (input: {
    userId: string
    instance: ConnectorInstance
  }) => Promise<{ serverName: string; tools: ConnectorLifecycleTool[] }>
  /** Runs before the local intent flip. Throwing leaves local state unchanged. */
  prepareDisconnect?: (input: {
    userId: string
    instance: ConnectorInstance
  }) => Promise<void>
}

export type ConnectorLifecycleDrivers = Readonly<Record<string, ConnectorLifecycleDriver>>
