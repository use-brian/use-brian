export const SUPPORT_DIAGNOSTIC_DURATIONS = [1, 24, 168] as const
export const SUPPORT_DIAGNOSTIC_EVENT_LIMIT = 5_000

export type SupportDiagnosticDurationHours = (typeof SUPPORT_DIAGNOSTIC_DURATIONS)[number]
export type SupportDiagnosticLevel = 'debug' | 'log' | 'warn' | 'error'

export type SupportDiagnosticCapture = {
  id: string
  userId: string
  workspaceId: string
  includeContent: boolean
  pseudonymSalt: Buffer
  startedAt: Date
  expiresAt: Date
  eventCount: number
}

export type SupportDiagnosticEvent = {
  id: number
  supportSessionId: string
  level: SupportDiagnosticLevel
  message: string
  fingerprint: string
  createdAt: Date
}

export type PendingSupportDiagnosticEvent = Omit<
  SupportDiagnosticEvent,
  'id' | 'supportSessionId' | 'createdAt'
> & {
  createdAt?: Date
}

export type SupportDiagnosticStatus = {
  active: boolean
  capture: {
    id: string
    workspaceId: string
    includeContent: boolean
    startedAt: string
    expiresAt: string
    eventCount: number
  } | null
}

export type SupportDiagnosticPreview = {
  captureId: string
  expiresAt: string
  includeContent: boolean
  selectedSessionId: string | null
  categories: Array<{ name: string; count: number }>
  warnings: string[]
}

export interface SupportDiagnosticsStore {
  start(params: {
    id: string
    userId: string
    workspaceId: string
    includeContent: boolean
    pseudonymSalt: Buffer
    expiresAt: Date
  }): Promise<SupportDiagnosticCapture>
  getAnyActive(): Promise<SupportDiagnosticCapture | null>
  getOwnedActive(userId: string, workspaceId: string): Promise<SupportDiagnosticCapture | null>
  appendEvents(captureId: string, events: PendingSupportDiagnosticEvent[]): Promise<void>
  listEvents(captureId: string): Promise<SupportDiagnosticEvent[]>
  deleteCapture(captureId: string): Promise<void>
  deleteOwnedCapture(userId: string, workspaceId: string): Promise<string | null>
  deleteExpired(): Promise<string[]>
}
