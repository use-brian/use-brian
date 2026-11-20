/** PostgreSQL merges creation defaults in grantee OID order. The grantor is
 * always the function owner, including for the optional PUBLIC entry. */
export function historicalFunctionExecuteAcl(runtimeId: string, includePublic: boolean): string {
  const grantees = includePublic ? `0::oid,owner_id,${runtimeId}` : `owner_id,${runtimeId}`
  return `ARRAY(SELECT makeaclitem(grantee,owner_id,'EXECUTE',false)
    FROM unnest(ARRAY[${grantees}]) AS roles(grantee) ORDER BY grantee)`
}

/** The same eight-function roster is checked as a group and again against
 * each source definition before 82980 rebinds any policy. Keep both checks. */
export function conversationTriggerPrivilegesExecutionSql(sql: string): string {
  const roster = 'bool_and(p.oid IS NOT NULL AND p.proacl IS NOT DISTINCT FROM reviewed.acl)'
  if (sql.split(roster).length !== 2) throw new Error('82980: historical ACL roster changed')
  const orderedRoster = `bool_and(p.oid IS NOT NULL AND p.proacl IS NOT DISTINCT FROM ARRAY(
    SELECT makeaclitem(a.grantee,a.grantor,a.privilege_type,a.is_grantable)
    FROM aclexplode(reviewed.acl) a ORDER BY a.grantee))`
  sql = sql.replace(roster, `(${roster} OR ${orderedRoster})`)

  const tag = '$ordinary_acl_historic$'
  const parts = sql.split(tag)
  if (parts.length !== 3) throw new Error('82980: historical routine checks changed')
  const owner = "makeaclitem(owner_role,owner_role,'EXECUTE',false)"
  const app = "makeaclitem('app_user'::regrole,owner_role,'EXECUTE',false)"
  const publicGrant = "makeaclitem(0,owner_role,'EXECUTE',false),"
  for (const [prefix, count] of [['', 5], [publicGrant, 2]] as const) {
    const appFirst = `actual.proacl IS DISTINCT FROM ARRAY[${prefix}${app},${owner}]`
    const ownerFirst = `actual.proacl IS DISTINCT FROM ARRAY[${prefix}${owner},${app}]`
    if (parts[1].split(appFirst).length !== count + 1) throw new Error('82980: historical routine ACL changed')
    parts[1] = parts[1].replaceAll(appFirst, `(${appFirst} AND ${ownerFirst})`)
  }
  return parts.join(tag)
}
