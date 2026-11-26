import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { persistentContextFixture } from './persistent-context.js'

export async function prepareRankedMaskPolicy(f: Awaited<ReturnType<typeof persistentContextFixture>>) {
  const suffix = randomUUID().replaceAll('-', '')
  const catalog = 'fixture_memory_mask_catalog_' + suffix
  const point = 'fixture_memory_mask_point_' + suffix
  const install = 'fixture_memory_mask_install_' + suffix
  await f.pool.query(`CREATE FUNCTION public.${catalog}(w uuid,o jsonb,t text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
    SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','fixture-rank-mask','policyVersion','1',
      'fieldKeys',to_jsonb(public.application_memory_field_keys()),
      'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,
        'read',CASE WHEN key='created_at' THEN '[["rank_reader"]]'::jsonb ELSE '[]'::jsonb END,
        'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb))
        FROM unnest(public.application_memory_field_keys()) AS key),
      'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,
        'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb))
    WHERE w='${f.workspaceId}'::uuid AND t='memory'
    $fixture$;
    CREATE FUNCTION public.${point}(w uuid,o jsonb,t text,i text) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      SELECT (public.${catalog}(w,o,t)-'scope')||jsonb_build_object(
        'recordVersion',m.scope_version::text,'source',public.read_scope_source(w,'memory',m.id))
      FROM public.memories m WHERE m.workspace_id=w AND m.id=i::uuid
    $fixture$;
    CREATE FUNCTION public.${install}() RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      INSERT INTO public.application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
      VALUES('native','1',ARRAY['rank_reader'],'public.${point}(uuid,jsonb,text,text)'::regprocedure,
        'public.${catalog}(uuid,jsonb,text)'::regprocedure);
      INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key)
      VALUES('${f.workspaceId}'::uuid,'{"kind":"native","moduleKey":"native"}','memory','native')
    $fixture$;
    REVOKE ALL ON FUNCTION public.${catalog}(uuid,jsonb,text),public.${point}(uuid,jsonb,text,text),public.${install}() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.${install}() TO app_user`)
  return {
    async install(db: Pick<PoolClient, 'query'> = f.pool) {
      await db.query(`SELECT public.${install}()`)
    },
    async dispose() {
      await f.pool.query(`DELETE FROM application_native_resource_owners
        WHERE workspace_id=$1 AND resource_type='memory' AND module_key='native'`, [f.workspaceId])
      await f.pool.query(`DELETE FROM application_native_field_contracts
        WHERE module_key='native' AND metadata_reader='public.${point}(uuid,jsonb,text,text)'::regprocedure`)
      await f.pool.query(`DROP FUNCTION IF EXISTS public.${install}(),
        public.${point}(uuid,jsonb,text,text),public.${catalog}(uuid,jsonb,text)`)
    },
  }
}
