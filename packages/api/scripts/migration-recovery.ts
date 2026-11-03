import { readFile } from 'node:fs/promises'

/** [COMP:api/migration-recovery] Authenticate one known schema/ledger crash boundary. */
export async function nativePageCompletionRecoverySql(): Promise<string> {
  // Reuse the immutable successor's independently authored authentication, not
  // live fingerprints or a second, drifting copy of its executable manifest.
  const successor = await readFile(new URL('../migrations/8201_native_turn_publication_cohorts.sql', import.meta.url), 'utf8')
  const start = successor.indexOf('SET LOCAL search_path=pg_catalog,public,pg_temp;')
  const end = successor.indexOf('CREATE TEMP TABLE pg_temp.native_cohort_originals ON COMMIT DROP AS')
  if (start < 0 || end <= start) throw new Error('Missing canonical Page-completion recovery authentication')
  const authentication = successor.slice(start, end)
  // Keep the extraction strictly read-only and stop before the successor DDL.
  if (!authentication.trimEnd().endsWith('END $bridge$;')
    || (authentication.match(/^DO \$/gm) ?? []).length !== 5) {
    throw new Error('Changed canonical Page-completion recovery authentication boundary')
  }
  return `DO $recover_page_completion$
BEGIN
 IF EXISTS (SELECT 1 FROM public._migrations WHERE name='8199_native_turn_compact_requirements.sql')
  AND NOT EXISTS (SELECT 1 FROM public._migrations WHERE name='8200_native_turn_page_completion.sql')
  AND to_regprocedure('public.native_turn_page_event(jsonb)') IS NOT NULL THEN
  EXECUTE '${authentication.replaceAll("'", "''")}';
  INSERT INTO public._migrations(name) VALUES ('8200_native_turn_page_completion.sql');
  RAISE NOTICE 'Recovered authenticated migration ledger entry: 8200_native_turn_page_completion.sql';
 END IF;
END $recover_page_completion$;`
}
