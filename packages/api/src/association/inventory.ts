/** Shared event-first inventory authority and committed boundaries. [COMP:crm/association-inventory] */
import type { PoolClient } from 'pg'
import { CrmOperationsError } from '@use-brian/core/crm/operations-types.js'

type InventoryReferences = { eventIds?: string[]; ticketIds?: string[]; orderId?: string; registrationId?: string }

/** Event locks precede ticket/order/registration locks on every commerce path. */
export async function lockAssociationInventory(client: PoolClient, workspaceId: string, input: InventoryReferences): Promise<string[]> {
  const refs = await client.query<{ event_id: string }>(
    `SELECT DISTINCT event_id FROM association_ticket_types WHERE workspace_id=$1 AND id=ANY($2::uuid[])
     UNION SELECT DISTINCT t.event_id FROM association_order_lines l
       JOIN association_ticket_types t ON t.workspace_id=l.workspace_id AND t.id=l.ticket_id
       WHERE l.workspace_id=$1 AND l.order_id=$3
     UNION SELECT event_id FROM association_registrations WHERE workspace_id=$1 AND id=$4`,
    [workspaceId, input.ticketIds ?? [], input.orderId ?? null, input.registrationId ?? null],
  )
  const ids = [...new Set([...(input.eventIds ?? []), ...refs.rows.map(r => r.event_id)])].sort()
  if (!ids.length) return []
  await client.query('SELECT id FROM association_events WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [workspaceId, ids])
  await client.query('SELECT id FROM association_ticket_types WHERE workspace_id=$1 AND event_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [workspaceId, ids])
  // A noncanonical caller must not move a ticket into an event we did not lock.
  const moved = await client.query(
    `SELECT 1 FROM association_ticket_types WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND NOT(event_id=ANY($3::uuid[])) LIMIT 1`,
    [workspaceId, input.ticketIds ?? [], ids],
  )
  if (moved.rowCount) throw new CrmOperationsError('conflict', 'Inventory configuration changed; retry the operation.')
  return ids
}

type InventoryScope = { event_id: string; ticket_id: string | null; event_key: string; ticket_key: string | null; capacity: number | null; used: number }

/** Caller holds each affected event lock through commit. No attendee payload. */
export async function refreshAssociationInventory(
  client: PoolClient,
  workspaceId: string,
  eventIds: string[],
  actorKind: string,
  options: { emitEvents?: boolean } = {},
): Promise<void> {
  if (!eventIds.length) return
  const scopes = (await client.query<InventoryScope>(
    `WITH occupied AS (
       SELECT event_id,ticket_id,count(*)::int used FROM association_registrations
       WHERE workspace_id=$1 AND event_id=ANY($2::uuid[])
         AND NOT historical_import AND (status IN('confirmed','checked_in','registered','attended')
           OR (status='reserved' AND reservation_expires_at>statement_timestamp()))
       GROUP BY event_id,ticket_id
     ) SELECT e.id event_id,NULL::uuid ticket_id,e.slug event_key,NULL::text ticket_key,e.capacity,COALESCE(sum(o.used),0)::int used
       FROM association_events e LEFT JOIN occupied o ON o.event_id=e.id
       WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) GROUP BY e.id
     UNION ALL SELECT t.event_id,t.id,e.slug,t.ticket_key,t.capacity,COALESCE(o.used,0)::int
       FROM association_ticket_types t JOIN association_events e ON e.workspace_id=t.workspace_id AND e.id=t.event_id
       LEFT JOIN occupied o ON o.ticket_id=t.id WHERE t.workspace_id=$1 AND t.event_id=ANY($2::uuid[])
     ORDER BY event_id,ticket_id NULLS FIRST`,
    [workspaceId, eventIds],
  )).rows
  for (const scope of scopes) {
    const current = (await client.query<{ id: string; sold_out: boolean; revision: number }>(
      `SELECT id,sold_out,revision FROM association_inventory_boundaries
       WHERE workspace_id=$1 AND event_id=$2 AND ticket_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
      [workspaceId, scope.event_id, scope.ticket_id],
    )).rows[0]
    if (!current && scope.capacity === null) continue
    const soldOut = scope.capacity !== null && scope.used >= scope.capacity
    const changed = soldOut !== (current?.sold_out ?? false)
    const revision = (current?.revision ?? 0) + (changed ? 1 : 0)
    await client.query(
      `INSERT INTO association_inventory_boundaries(workspace_id,event_id,ticket_id,sold_out,revision,capacity,used)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,event_id,ticket_id) DO UPDATE
       SET sold_out=EXCLUDED.sold_out,revision=EXCLUDED.revision,capacity=EXCLUDED.capacity,used=EXCLUDED.used,updated_at=clock_timestamp()`,
      [workspaceId, scope.event_id, scope.ticket_id, soldOut, revision, scope.capacity, scope.used],
    )
    if (!changed || options.emitEvents === false) continue
    const eventType = soldOut ? 'association.inventory.sold_out' : 'association.inventory.available'
    const kind = scope.ticket_id ? 'ticket' : 'event', subjectId = scope.ticket_id ?? scope.event_id
    await client.query(
      `INSERT INTO crm_domain_event_outbox(workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(workspace_id,event_key) DO NOTHING`,
      [workspaceId, eventType, `association.inventory:${kind}:${subjectId}:${revision}`, kind, subjectId,
        JSON.stringify({ eventId: scope.event_id, eventKey: scope.event_key, ticketId: scope.ticket_id,
          ticketKey: scope.ticket_key, capacity: scope.capacity, used: scope.used, revision }),
        actorKind === 'api_key' ? 'brain_key' : actorKind],
    )
  }
}
