/** Fresh identity-only retained acquisition. [COMP:api/native-chat-read-cost] */
import type {PoolClient} from 'pg'

const ports={
 query:{signature:'read_native_retained_session_query(uuid,uuid,integer,integer)',sql:'SELECT read_native_retained_session_query($1,$2,$3,$4) AS value'},
 scope:{signature:'read_native_retained_scope_evidence(uuid,jsonb)',sql:'SELECT read_native_retained_scope_evidence($1,$2) AS value'},
 cohorts:{signature:'read_native_retained_publication_cohorts(uuid,jsonb)',sql:'SELECT read_native_retained_publication_cohorts($1,$2) AS value'},
} as const

/** Presence is capability metadata. Each invocation independently mints and
 * validates its own private graph; only NULL permits pre-write fallback. */
export async function readRetainedNativePacket(client:Pick<PoolClient,'query'>,kind:keyof typeof ports,args:unknown[]):Promise<unknown|null>{
 const port=ports[kind]
 const installed=(await client.query<{available:boolean}>(
  'SELECT to_regprocedure($1) IS NOT NULL AS available',[`public.${port.signature}`])).rows[0]?.available===true
 if(!installed)return null
 const row=(await client.query<{value:unknown}>(port.sql,args)).rows[0]
 if(!row||!Object.hasOwn(row,'value')||row.value===undefined)throw new Error('Retained native acquisition packet missing')
 return row.value
}
