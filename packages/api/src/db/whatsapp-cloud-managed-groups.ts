import { query, queryWithRLS } from './client.js'

export type WhatsAppCloudManagedGroupStatus = 'creating' | 'active' | 'failed'

export type WhatsAppCloudManagedGroup = {
  id: string
  channelId: string
  requestId: string | null
  providerGroupId: string | null
  subject: string
  inviteLink: string | null
  status: WhatsAppCloudManagedGroupStatus
  error: string | null
  createdAt: Date
  updatedAt: Date
}

const COLUMNS = `
  id,
  channel_id AS "channelId",
  request_id AS "requestId",
  provider_group_id AS "providerGroupId",
  subject,
  invite_link AS "inviteLink",
  status,
  error,
  created_at AS "createdAt",
  updated_at AS "updatedAt"`

export interface WhatsAppCloudManagedGroupStore {
  createPending(userId: string, channelId: string, subject: string): Promise<WhatsAppCloudManagedGroup>
  attachRequestId(userId: string, id: string, requestId: string): Promise<WhatsAppCloudManagedGroup>
  deletePending(userId: string, id: string): Promise<boolean>
  listByChannel(userId: string, channelId: string): Promise<WhatsAppCloudManagedGroup[]>
  completeFromLifecycle(requestId: string, providerGroupId: string, inviteLink: string): Promise<boolean>
  failFromLifecycle(requestId: string, error: string): Promise<boolean>
}

export const whatsappCloudManagedGroupStore: WhatsAppCloudManagedGroupStore = {
  async createPending(userId, channelId, subject) {
    const result = await queryWithRLS<WhatsAppCloudManagedGroup>(
      userId,
      `INSERT INTO whatsapp_cloud_managed_groups (channel_id, subject)
       VALUES ($1, $2)
       RETURNING ${COLUMNS}`,
      [channelId, subject],
    )
    if (!result.rows[0]) throw new Error('Failed to create managed WhatsApp group row')
    return result.rows[0]
  },

  async attachRequestId(userId, id, requestId) {
    const result = await queryWithRLS<WhatsAppCloudManagedGroup>(
      userId,
      `UPDATE whatsapp_cloud_managed_groups
       SET request_id = $2
       WHERE id = $1 AND status = 'creating' AND request_id IS NULL
       RETURNING ${COLUMNS}`,
      [id, requestId],
    )
    if (!result.rows[0]) throw new Error('Managed WhatsApp group is no longer pending')
    return result.rows[0]
  },

  async deletePending(userId, id) {
    const result = await queryWithRLS(
      userId,
      `DELETE FROM whatsapp_cloud_managed_groups
       WHERE id = $1 AND status = 'creating' AND request_id IS NULL`,
      [id],
    )
    return (result.rowCount ?? 0) > 0
  },

  async listByChannel(userId, channelId) {
    const result = await queryWithRLS<WhatsAppCloudManagedGroup>(
      userId,
      `SELECT ${COLUMNS}
       FROM whatsapp_cloud_managed_groups
       WHERE channel_id = $1
       ORDER BY created_at ASC`,
      [channelId],
    )
    return result.rows
  },

  async completeFromLifecycle(requestId, providerGroupId, inviteLink) {
    const result = await query(
      `UPDATE whatsapp_cloud_managed_groups
       SET provider_group_id = $2, invite_link = $3, status = 'active', error = NULL
       WHERE request_id = $1
         AND status IN ('creating', 'active')
         AND (provider_group_id IS NULL OR provider_group_id = $2)
       RETURNING id`,
      [requestId, providerGroupId, inviteLink],
    )
    return (result.rowCount ?? 0) > 0
  },

  async failFromLifecycle(requestId, error) {
    const result = await query(
      `UPDATE whatsapp_cloud_managed_groups
       SET status = 'failed', error = $2
       WHERE request_id = $1 AND status IN ('creating', 'failed')`,
      [requestId, error],
    )
    return (result.rowCount ?? 0) > 0
  },
}
