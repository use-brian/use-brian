import * as channels from '@use-brian/channels'

export type WhatsAppCloudManagedGroupsApi = {
  createGroup(subject: string): Promise<{ requestId: string }>
  getGroupInviteLink(groupId: string): Promise<string>
  deleteGroup(groupId: string): Promise<void>
}

type ExpectedChannelsExports = {
  createWhatsAppCloudApi(options: {
    accessToken: string
    phoneNumberId: string
    graphApiVersion?: string
  }): {
    createGroup(subject: string): Promise<string | { requestId: string }>
    getGroupInviteLink(groupId: string): Promise<string>
    deleteGroup(groupId: string): Promise<void>
  }
  WhatsAppCloudApiError: new (...args: never[]) => Error & { status: number }
  parseWhatsAppCloudGroupLifecycleEvents(payload: unknown): Array<{
    phoneNumberId: string
    rows: Array<{
      type: string
      requestId: string
      groupId?: string
      inviteLink?: string
      errors?: unknown[]
    }>
  }>
}

export type WhatsAppCloudGroupLifecycleEvent = {
  requestId: string
  phoneNumberId: string
  event: string
  groupId: string | null
  inviteLink?: string | null
  error?: string | null
}

function expectedChannels(): ExpectedChannelsExports {
  return channels as unknown as ExpectedChannelsExports
}

export function createWhatsAppCloudManagedGroupsApi(options: {
  accessToken: string
  phoneNumberId: string
  graphApiVersion?: string
}): WhatsAppCloudManagedGroupsApi {
  const api = expectedChannels().createWhatsAppCloudApi(options)
  return {
    async createGroup(subject) {
      const result = await api.createGroup(subject)
      return typeof result === 'string' ? { requestId: result } : result
    },
    getGroupInviteLink: (groupId) => api.getGroupInviteLink(groupId),
    deleteGroup: (groupId) => api.deleteGroup(groupId),
  }
}

export function parseWhatsAppCloudManagedGroupLifecycleEvents(
  payload: unknown,
): WhatsAppCloudGroupLifecycleEvent[] {
  const parse = expectedChannels().parseWhatsAppCloudGroupLifecycleEvents
  if (typeof parse !== 'function') return []
  return parse(payload).flatMap(({ phoneNumberId, rows }) => rows.map((row) => ({
    requestId: row.requestId,
    phoneNumberId,
    event: row.type,
    groupId: row.groupId ?? null,
    inviteLink: row.inviteLink ?? null,
    error: row.errors?.length ? JSON.stringify(row.errors) : null,
  })))
}

export function isWhatsAppCloudNotFoundError(error: unknown): boolean {
  const ErrorClass = expectedChannels().WhatsAppCloudApiError
  return typeof ErrorClass === 'function' && error instanceof ErrorClass && error.status === 404
}
