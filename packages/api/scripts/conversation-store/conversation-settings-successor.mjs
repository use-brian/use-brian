// [COMP:api/conversation-visibility] Preserve the original session context
// guards and admit only the exact transition recorded by the settings owner.
import { readFile } from 'node:fs/promises'

const literal = value => "'" + value.replaceAll("'", "''") + "'"
const replaceOnce = (source, previous, next) => {
  if (source.split(previous).length !== 2) throw new Error('conversation_settings_guard_source_changed')
  return source.replace(previous, () => next)
}
const matchTransition = `public.conversation_settings_transition_matches(OLD.id,
    OLD.context_project_id,NEW.context_project_id,OLD.context_compartments,NEW.context_compartments)`

const guards = [
  {
    file: '473_context_principal_bindings.sql',
    signature: 'prevent_locked_session_context_change()',
    update: original => replaceOnce(original, '  ) THEN', `  ) AND NOT (NEW.context_group_id IS NOT DISTINCT FROM OLD.context_group_id
    AND ${matchTransition}) THEN`),
  },
  {
    file: '749_project_shared_spaces.sql',
    signature: 'stamp_session_project_label()',
    update: original => replaceOnce(original, 'BEGIN\n  IF NEW.context_locked_at', `BEGIN
  IF TG_OP='UPDATE' THEN
    IF ${matchTransition} THEN RETURN NEW;END IF;
  END IF;
  IF NEW.context_locked_at`),
  },
  {
    file: '749_project_shared_spaces.sql',
    signature: 'validate_session_context_binding()',
    update: original => replaceOnce(original, `  team_labels text[];
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW.context_compartments, '{}'::text[])) k
              WHERE k LIKE 'project:%' AND (k IS DISTINCT FROM project_label OR NOT EXISTS (
                SELECT 1 FROM public.project_shared_scopes s WHERE s.project_id = NEW.context_project_id AND s.workspace_id = NEW.workspace_id))) THEN`,
    `  team_labels text[];
  reviewed_transition boolean:=false;
BEGIN
  IF TG_OP='UPDATE' THEN reviewed_transition:=${matchTransition};END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(NEW.context_compartments, '{}'::text[])) k
              WHERE k LIKE 'project:%' AND ((NOT reviewed_transition AND k IS DISTINCT FROM project_label) OR NOT EXISTS (
                SELECT 1 FROM public.project_shared_scopes s WHERE 'project:'||s.project_id::text=k AND s.workspace_id = NEW.workspace_id))) THEN`),
  },
]

async function sourceDefinition({ file, signature }) {
  const migration = await readFile(new URL('../../migrations/' + file, import.meta.url), 'utf8')
  const name = signature.split('(')[0]
  const declaration = new RegExp(`^CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?${name}\\(`, 'm').exec(migration)
  if (!declaration) throw new Error('conversation_settings_guard_declaration_missing: ' + signature)
  const body = migration.indexOf('AS $$', declaration.index)
  const end = migration.indexOf('$$;', body + 5)
  if (body < 0 || end < 0) throw new Error('conversation_settings_guard_definition_missing: ' + signature)
  return migration.slice(declaration.index, end + 3)
}

export async function buildConversationSettingsSuccessor() {
  const replacements = await Promise.all(guards.map(async guard => {
    const original = await sourceDefinition(guard)
    const name = guard.signature.split('(')[0]
    const reference = `pg_temp.reviewed_${name}`
    return {
      referenceSignature: reference + '()',
      referenceDefinition: original.replace(/^CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?[^\s(]+/, 'CREATE FUNCTION ' + reference),
      installedSignature: 'public.' + guard.signature,
      successor: guard.update(original).replace(/^CREATE(?: OR REPLACE)? FUNCTION/, 'CREATE OR REPLACE FUNCTION'),
    }
  }))
  return `${replacements.map(item => item.referenceDefinition).join('\n')}
DO $settings_guard_authentication$
DECLARE pair record;current_definition jsonb;reviewed_definition jsonb;
BEGIN
 FOR pair IN SELECT * FROM (VALUES ${replacements.map(item => `(${literal(item.installedSignature)},${literal(item.referenceSignature)})`).join(',')}) AS guard(installed,reviewed) LOOP
  SELECT to_jsonb(p)-ARRAY['oid','proname','pronamespace','proacl'] INTO current_definition FROM pg_proc p WHERE oid=to_regprocedure(pair.installed);
  SELECT to_jsonb(p)-ARRAY['oid','proname','pronamespace','proacl'] INTO STRICT reviewed_definition FROM pg_proc p WHERE oid=to_regprocedure(pair.reviewed);
  IF current_definition IS DISTINCT FROM reviewed_definition THEN
   RAISE EXCEPTION 'conversation_settings_guard_changed: %',pair.installed;
  END IF;
 END LOOP;
END $settings_guard_authentication$;
${replacements.map(item => item.successor).join('\n')}
DROP FUNCTION ${replacements.map(item => item.referenceSignature).join(',')};`
}
