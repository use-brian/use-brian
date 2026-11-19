// [COMP:api/caller-scope-evidence] Install and authenticate the mixed-source topology route.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly, currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8315.mjs'
import { rowTransitionsMigrationName } from './build-conversation-retained-row-transitions.mjs'

const reviewedFunctions = [
  ['conversation_mixed_evidence_route', 'route'],
  ['capture_hybrid_conversation_evidence', 'hybrid'],
]
const prefix = 'a8314_'
const start = '-- BEGIN REVIEWED MIXED EVIDENCE ROUTE\n'
const end = '-- END REVIEWED MIXED EVIDENCE ROUTE'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const hash = value => createHash('sha256').update(value).digest('hex')
export const mixedEvidenceRouteMigration = '8316_conversation_mixed_evidence_route.sql'

const readDeclaration = () => readFile(new URL('./mixed-evidence-route.sql', import.meta.url), 'utf8')
function replaceOnce(source, marker, replacement) {
  if (source.split(marker).length !== 2) throw Error('mixed_evidence_route_source_changed')
  return source.replace(marker, () => replacement)
}
export async function routeBodyDigest() {
  const source = await readDeclaration()
  return Object.fromEntries(reviewedFunctions.map(([name, delimiter]) => {
    const sections = source.split('$' + delimiter + '$')
    if (sections.length !== 3 || !sections[1].startsWith('\nDECLARE\n')) throw Error('mixed_evidence_route_definition_changed')
    return [name, hash(sections[1])]
  }))
}

export async function buildMixedEvidenceRouteMigration(options) {
  const [previous, source] = await Promise.all([previousSource(options), readDeclaration()])
  return `-- [COMP:api/caller-scope-evidence] Install the reviewed mixed-source topology route.
BEGIN;
DO $mixed_evidence_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${rowTransitionsMigrationName}')
 ${reviewedFunctions.map(([name]) => `OR to_regprocedure('public.${name}(uuid,jsonb)') IS NOT NULL`).join('\n ')}
 THEN RAISE EXCEPTION 'mixed_evidence_route_predecessor_changed';END IF;
END $mixed_evidence_predecessor$;
${previous.sql}
${start}${source}${end}
${previous.cleanup}
COMMIT;\n`
}

export async function mixedEvidenceRouteInstallationSource(migration, options) {
  const [previous, source] = await Promise.all([previousSource(options), readDeclaration()])
  if (!migration.includes(start + source + end)) throw Error('mixed_evidence_route_definition_changed')
  const probe = reviewedFunctions.map(([name]) => {
    const reference = name + '_reviewed'
    const start = source.indexOf('CREATE FUNCTION public.' + name)
    const declaration = source.slice(start, source.indexOf('\nREVOKE', start))
    const reviewed = replaceOnce(declaration, 'CREATE FUNCTION public.' + name, 'CREATE FUNCTION pg_temp.' + reference)
    return `DO $mixed_evidence_reference$ BEGIN
 EXECUTE ${literal(reviewed)};
END $mixed_evidence_reference$;
DO $mixed_evidence_catalog$
DECLARE actual pg_proc;reviewed pg_proc;owner_id oid;app_id oid;
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.sessions'::regclass;
 SELECT oid INTO STRICT app_id FROM pg_roles WHERE rolname='app_user';
 SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid='pg_temp.${reference}(uuid,jsonb)'::regprocedure;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.${name}(uuid,jsonb)');
 IF actual.oid IS NULL OR actual.proowner IS DISTINCT FROM owner_id
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
  OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
     (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
 THEN RAISE EXCEPTION 'installation_mixed_evidence_route_changed';END IF;
END $mixed_evidence_catalog$;`
  }).join('\n')
  const receipt = 'SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.' + prefix + 'publication_expected_current)::text'
  let sql = replaceOnce(previous.sql, receipt, probe + '\n' + receipt
    + reviewedFunctions.map(([name]) => `||(SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid='public.${name}(uuid,jsonb)'::regprocedure)::text`).join(''))
  sql = replaceOnce(sql, ')::int functions,', '+2)::int functions,')
  assertAuthenticationReadOnly(sql)
  return { ...previous, sql, cleanup: previous.cleanup + reviewedFunctions.map(([name]) => `\nDROP FUNCTION pg_temp.${name}_reviewed(uuid,jsonb);`).join(''),
    functions: previous.functions + 2, sourceDigest: hash(migration), migrationSha: hash(migration) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  const directory = new URL('../../migrations/', import.meta.url)
  const migration = new URL(mixedEvidenceRouteMigration, directory)
  const sql = await buildMixedEvidenceRouteMigration()
  if (mode === '--candidate' && target) await writeFile(resolve(target), sql, { mode: 0o600, flag: 'wx' })
  else if (mode === '--check' && !target) {
    if (await readFile(migration, 'utf8') !== sql) throw Error('mixed_evidence_route_numbered_source_changed')
  } else if (!mode) {
    const hosted = new URL('../../../../../packages/api-platform/migrations/', import.meta.url)
    const files = (await Promise.all([readdir(directory), readdir(hosted)])).flat()
    if (files.some(file => file.startsWith('8316_'))) throw Error('mixed_evidence_route_number_occupied')
    await writeFile(migration, sql, { flag: 'wx' })
  } else throw Error('Use --candidate PATH or --check')
}
