import { createHash } from 'node:crypto'

/** Portable execution of the immutable Page successor's two catalog pins.
 * [COMP:api/migration-execution-sql]
 * Only runtime catalog fingerprints change; every other source byte remains
 * authenticated against its independently captured predecessor/successor hash.
 */
const sourceHash = '4f58c737f519fc9a2726c13ae6d04d5c38f1e78973bc841af273e9e4e36ea5e2'
const templates: Record<string, { guard: string; fingerprint: string; occurrences: number; before: string; after: string }> = {
  "validate_page_derivation_dependencies()": {
    "guard": "native_turn_page_event(jsonb)",
    "fingerprint": "61ece67a93c1c995cf10e23256cf47489a845e0a8b9347c6ab4ed298c6cdcd4f",
    "occurrences": 1,
    "before": "43c1c80e8798d7bd2e84531180330e3b671c55a156d0144320ed2650f3653ec2",
    "after": "272f2b2efb62bafb7391ce1488f5f395883fa7ac7245e69c4bbc138fe8be10f3"
  },
  "prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)": {
    "guard": "application_native_transcript_prepare_helpers_current()",
    "fingerprint": "2fc7c5a9c0b2c3f51159c21f6e4bfc9722edfc61f9d8d90cec22aa6ad4c85467",
    "occurrences": 2,
    "before": "9bc4eddfff886576390033eb67febfe659003733aff9b827e41480049c0ea692",
    "after": "49539a060e19044e5bc2793b782c5c276ea26faf861c67ea85008019b7059967"
  }
}

export function pageThreadSourceExecutionSql(sql: string): string {
  if (createHash('sha256').update(sql).digest('hex') !== sourceHash) throw new Error('Page migration source changed')
  let adapted = 0
  const output = sql.replace(/DO \$page_thread_patch\$([\s\S]*?)END \$page_thread_patch\$;/g, (whole, body: string) => {
    const signature = /SELECT \* INTO STRICT routine FROM pg_proc WHERE oid='([^']+)'::regprocedure/.exec(body)?.[1]
    const template = signature ? templates[signature] : undefined
    if (!template) return whole
    const guard = `(SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='${template.guard}'::regprocedure)`
    const once = (needle: string, replacement: string) => {
      if (body.split(needle).length !== 2) throw new Error('Page migration pin template changed')
      body = body.replace(needle, replacement)
    }
    once('successor constant text:=$page_thread_body$', 'successor text:=replace($page_thread_body$')
    once('$page_thread_body$;\nBEGIN', `$page_thread_body$,'${template.fingerprint}',${guard});\nBEGIN`)
    const predecessor = /encode\(sha256\(convert_to\(routine.prosrc,'UTF8'\)\),'hex'\) IS DISTINCT FROM '[a-f0-9]{64}'/.exec(body)?.[0]
    const successor = /encode\(sha256\(convert_to\(successor,'UTF8'\)\),'hex'\) IS DISTINCT FROM '[a-f0-9]{64}'/.exec(body)?.[0]
    if (!predecessor || !successor) throw new Error('Missing Page migration authentication')
    once(predecessor, `encode(sha256(convert_to(replace(routine.prosrc,${guard},'__GUARD__'),'UTF8')),'hex') IS DISTINCT FROM '${template.before}'
  OR (length(routine.prosrc)-length(replace(routine.prosrc,${guard},'')))/64<>${template.occurrences}`)
    once(successor, `encode(sha256(convert_to(replace(successor,${guard},'__GUARD__'),'UTF8')),'hex') IS DISTINCT FROM '${template.after}'`)
    adapted++
    return 'DO $page_thread_patch$'+body+'END $page_thread_patch$;'
  })
  if (adapted !== 2) throw new Error('Incomplete Page migration pin adaptation')
  return output
}
