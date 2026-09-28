import type { PoolClient } from 'pg'

/** Metadata projections have a bounded lifetime, even when a push signal is lost. */
export async function projectionLifetime(client: PoolClient, workspaceId: string, userId: string): Promise<number> {
  const result = await client.query<{ ttl: number }>(`
    WITH boundaries AS (
      SELECT now() + interval '30 seconds' AS boundary
      UNION ALL
      SELECT point FROM workspace_access_grants g
        CROSS JOIN LATERAL unnest(ARRAY[g.starts_at,g.expires_at]) AS point
        WHERE g.workspace_id=$1 AND g.revoked_at IS NULL AND point>now()
          AND can_view_department_request(g.request_id,$2)
      UNION ALL
      SELECT request_expires_at FROM workspace_access_requests r
        WHERE r.workspace_id=$1 AND r.status='pending' AND r.request_expires_at>now()
          AND can_view_department_request(r.id,$2)
    ) SELECT greatest(0,floor(extract(epoch FROM (min(boundary)-clock_timestamp()))*1000))::integer AS ttl
      FROM boundaries`, [workspaceId,userId])
  return result.rows[0].ttl
}
