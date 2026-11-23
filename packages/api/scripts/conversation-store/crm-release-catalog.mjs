// [COMP:api/portable-restore] Bind exact installed CRM source and catalog.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const crmMigrationPins = {
  '8319_crm_summary_policy_facts.sql': '921efbf857facc7957429d856e44accc096684142199399f58e7e337838f344f',
  '8320_crm_summary_entity_publications.sql': '22a5eb2038bef23910066fd8bb18da005d9965d5974bc7c1ff4ace163116f213',
  '8321_crm_summary_principal_basis.sql': '0ea175e0c9bd1374d1a7957973e1e86cc1550f435c0e803e112cf43722e84030',
  '8322_crm_summary_sealed_projection.sql': '97548d6aa29af708654e892377818288207eca5096082209e8ea06a74314445f',
  '8324_crm_summary_declared_lineage.sql': 'c32681b74d0b2e49672f36ace61ef6f85923c7c4ad0f4c4a2195992037668f75',
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const names = (source, pattern) => [...new Set([...source.matchAll(pattern)].map(match => match[1]))].sort()

export async function readPinnedCrmScope(sourceRoot) {
  const entries = Object.entries(crmMigrationPins)
  const text = (await Promise.all(entries.map(async ([migration, expectedSha256]) => {
    const bytes = await readFile(join(sourceRoot,'migrations',migration))
    if (sha(bytes)!==expectedSha256) throw Error('crm_installation_migration_source_changed: '+migration)
    return bytes.toString('utf8')
  }))).join('\n')
  const scope = {
    functions: names(text, /(?:^|\n)[ \t]*CREATE(?: OR REPLACE)? FUNCTION public\.([a-z_0-9]+)\s*\(/gi),
    tables: names(text, /(?:^|\n)[ \t]*(?:CREATE|ALTER) TABLE (?:IF NOT EXISTS )?public\.([a-z_0-9]+)/gi),
    types: names(text, /(?:^|\n)[ \t]*CREATE TYPE public\.([a-z_0-9]+)\b/gi),
    triggers: names(text, /(?:^|\n)[ \t]*CREATE (?:CONSTRAINT )?TRIGGER ([a-z_0-9]+)\b/gi),
  }
  if (!scope.functions.includes('read_crm_summary_sealed') || !scope.functions.includes('check_crm_summary_witness'))
    throw Error('crm_installation_catalog_scope_incomplete')
  return scope
}

// These catalog identifiers are independent of connection-local OIDs and
// normalize the ordinary installation owner's name across supported launchers.
const CATALOG = `
WITH runtime AS (SELECT current_user::regrole::oid role),
routines AS (
 SELECT p.proname name, pg_get_function_identity_arguments(p.oid) signature,
   pg_get_functiondef(p.oid) definition, l.lanname language,
   p.pronargdefaults defaults,p.prosecdef definer,p.proisstrict strict,p.provolatile volatility,
   p.proparallel parallel,p.proleakproof leakproof,p.procost cost,p.prorows declared_rows,
   CASE WHEN p.proowner=runtime.role THEN '<installation-owner>' ELSE p.proowner::regrole::text END owner,
   (SELECT jsonb_agg(jsonb_build_array(
     CASE WHEN a.grantor=runtime.role THEN '<installation-owner>' ELSE a.grantor::regrole::text END,
     CASE WHEN a.grantee=0 THEN '<public>' WHEN a.grantee=runtime.role THEN '<installation-owner>' ELSE a.grantee::regrole::text END,
     a.privilege_type,a.is_grantable) ORDER BY a.privilege_type COLLATE "C",a.is_grantable,
     (CASE WHEN a.grantee=0 THEN '<public>' WHEN a.grantee=runtime.role THEN '<installation-owner>' ELSE a.grantee::regrole::text END) COLLATE "C",
     (CASE WHEN a.grantor=runtime.role THEN '<installation-owner>' ELSE a.grantor::regrole::text END) COLLATE "C")
    FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) acl
 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang CROSS JOIN runtime
 WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[])
),
relations AS (
 SELECT c.relname name,c.relkind kind,c.relrowsecurity rls,c.relforcerowsecurity force_rls,
   CASE WHEN c.relowner=runtime.role THEN '<installation-owner>' ELSE c.relowner::regrole::text END owner,
   (SELECT jsonb_agg(jsonb_build_array(
     CASE WHEN a.grantor=runtime.role THEN '<installation-owner>' ELSE a.grantor::regrole::text END,
     CASE WHEN a.grantee=0 THEN '<public>' WHEN a.grantee=runtime.role THEN '<installation-owner>' ELSE a.grantee::regrole::text END,
     a.privilege_type,a.is_grantable) ORDER BY a.privilege_type COLLATE "C",a.is_grantable,
     (CASE WHEN a.grantee=0 THEN '<public>' WHEN a.grantee=runtime.role THEN '<installation-owner>' ELSE a.grantee::regrole::text END) COLLATE "C",
     (CASE WHEN a.grantor=runtime.role THEN '<installation-owner>' ELSE a.grantor::regrole::text END) COLLATE "C")
    FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a) acl,
   (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
            a.attgenerated,a.attidentity,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) columns,
   (SELECT jsonb_agg(jsonb_build_array(k.conname,pg_get_constraintdef(k.oid),k.convalidated)
                    ORDER BY k.conname COLLATE "C")
    FROM pg_constraint k WHERE k.conrelid=c.oid) constraints,
   (SELECT jsonb_agg(jsonb_build_array(i.relname,pg_get_indexdef(d.indexrelid),d.indisvalid,d.indisready)
                    ORDER BY i.relname COLLATE "C")
    FROM pg_index d JOIN pg_class i ON i.oid=d.indexrelid WHERE d.indrelid=c.oid) indexes,
   (SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,
           ARRAY(SELECT CASE WHEN r=0 THEN '<public>' WHEN r=runtime.role THEN '<installation-owner>' ELSE r::regrole::text END
              FROM unnest(p.polroles) r ORDER BY (CASE WHEN r=0 THEN '<public>' WHEN r=runtime.role THEN '<installation-owner>' ELSE r::regrole::text END) COLLATE "C"),
           pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname COLLATE "C")
    FROM pg_policy p WHERE p.polrelid=c.oid) policies
 FROM pg_class c CROSS JOIN runtime
 WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($2::text[])
),
types AS (
 SELECT t.typname name, t.typtype kind,
   CASE WHEN t.typowner=runtime.role THEN '<installation-owner>' ELSE t.typowner::regrole::text END owner,
   (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull)
            ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped) attributes
 FROM pg_type t CROSS JOIN runtime
 WHERE t.typnamespace='public'::regnamespace AND t.typname=ANY($3::text[])
),
triggers AS (
 SELECT t.tgname name,c.relname relation,t.tgenabled enabled,pg_get_triggerdef(t.oid) definition
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
   AND (c.relname=ANY($2::text[]) OR t.tgname=ANY($4::text[]))
)
SELECT jsonb_build_object(
 'routines',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.name COLLATE "C",r.signature COLLATE "C") FROM routines r),
 'relations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.name COLLATE "C") FROM relations r),
 'types',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name COLLATE "C") FROM types t),
 'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.relation COLLATE "C",t.name COLLATE "C") FROM triggers t)
)::text AS catalog;`

export async function readReviewedCrmCatalog(owner, scope) {
  if (scope.closedPrefixes) {
    const unexpected = (await owner.query(`SELECT p.proname name FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace
      AND EXISTS(SELECT 1 FROM unnest($1::text[]) prefix WHERE starts_with(p.proname,prefix))
      AND NOT(p.proname=ANY($2::text[]))
      UNION ALL SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p')
      AND EXISTS(SELECT 1 FROM unnest($3::text[]) prefix WHERE starts_with(c.relname,prefix))
      AND NOT(c.relname=ANY($4::text[]))`, [scope.closedPrefixes.functions, scope.functions, scope.closedPrefixes.tables, scope.tables])).rows
    if (unexpected.length) throw Error('portable_successor_unknown_catalog_object')
  }
  const value = (await owner.query(CATALOG, [scope.functions,scope.tables,scope.types,scope.triggers])).rows[0]?.catalog
  if (typeof value !== 'string') throw Error('crm_installation_catalog_unavailable')
  const valueJson = JSON.parse(value)
  return { sha256: sha(value), routines: valueJson.routines?.length ?? 0,
    relations: valueJson.relations?.length ?? 0, types: valueJson.types?.length ?? 0, triggers: valueJson.triggers?.length ?? 0 }
}

export function composeCrmSource(predecessor, inventory, scope) {
  if (!predecessor.sql || !predecessor.cleanup || inventory.scopeSha256 !== sha(JSON.stringify(scope)))
    throw Error('crm_installation_reviewed_inventory_changed')
  const sourceDigest = sha(JSON.stringify({ predecessor: predecessor.sourceDigest, migrations: crmMigrationPins, inventory }))
  return { ...predecessor, sourceDigest, crmScope: scope, crmInventory: inventory }
}

export async function authenticateCrmSuccessor(owner, source) {
  if (owner?.getTransactionStatus?.() !== 'I') throw Error('installation_authentication_requires_idle_owner')
  await owner.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const installed = (await owner.query('SELECT name FROM public._migrations WHERE name=ANY($1::text[]) ORDER BY name COLLATE "C"',
      [Object.keys(crmMigrationPins)])).rows.map(row=>row.name)
    if (JSON.stringify(installed)!==JSON.stringify(Object.keys(crmMigrationPins)))
      throw Error('crm_installation_migration_tail_missing')
    const preceding = await owner.query(source.sql)
    const row = (Array.isArray(preceding) ? preceding.at(-1) : preceding)?.rows?.[0]
    if (!row?.witness_current || row.functions!==source.functions || !/^[a-f0-9]{64}$/.test(row.local_digest))
      throw Error('installation_authentication_receipt_malformed')
    await owner.query(source.cleanup)
    await owner.query('SET LOCAL search_path=pg_catalog,public')
    const actual = await readReviewedCrmCatalog(owner, source.crmScope)
    const { scopeSha256, ...expected } = source.crmInventory
    if (Object.entries(actual).some(([key,value])=>expected[key]!==value)) throw Error('crm_installation_catalog_changed')
    let localDigests = row.local_digest + actual.sha256
    for (const expectedCatalog of source.additionalCatalogs ?? (source.additionalCatalog ? [source.additionalCatalog] : [])) {
      const catalog = await readReviewedCrmCatalog(owner, expectedCatalog.scope)
      if (catalog.sha256 !== expectedCatalog.sha256) throw Error('installation_additional_catalog_changed')
      localDigests += catalog.sha256
    }
    if (source.portableSuccessor) {
      const { scope, inventory, migrations } = source.portableSuccessor
      const receipts = (await owner.query('SELECT name FROM public._migrations WHERE name=ANY($1::text[]) ORDER BY name COLLATE "C"', [migrations])).rows.map(row => row.name)
      if (JSON.stringify(receipts) !== JSON.stringify(migrations)) throw Error('portable_successor_migration_tail_missing')
      const catalog = await readReviewedCrmCatalog(owner, scope)
      if (Object.entries(catalog).some(([key, value]) => inventory[key] !== value)) throw Error('portable_successor_catalog_changed')
      localDigests += catalog.sha256
    }
    await owner.query('COMMIT')
    return Object.freeze({ format: 1, sourceDefinitionDigest: source.sourceDigest, functions: source.functions,
      localContractDigest: sha(localDigests), witnessCurrent: true })
  } catch (error) {
    await owner.query('ROLLBACK').catch(()=>{})
    throw error
  }
}
