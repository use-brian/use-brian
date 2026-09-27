BEGIN;

-- Raw request/grant RLS remains admin-only. This scalar exposes only a bounded
-- lifetime for the current member, in the calling source query's snapshot.
CREATE FUNCTION department_media_valid_for_ms(p_workspace_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH actor AS (
    SELECT nullif(current_setting('app.current_user_id',true),'')::uuid AS id
  ), boundaries AS (
    SELECT now()+interval '30 seconds' AS boundary
    UNION ALL
    SELECT point FROM workspace_access_grants g
      CROSS JOIN LATERAL unnest(ARRAY[g.starts_at,g.expires_at]) AS point
      WHERE g.workspace_id=p_workspace_id AND g.revoked_at IS NULL AND point>now()
        AND can_view_department_request(g.request_id,(SELECT id FROM actor))
    UNION ALL
    SELECT request_expires_at FROM workspace_access_requests r
      WHERE r.workspace_id=p_workspace_id AND r.status='pending' AND r.request_expires_at>now()
        AND can_view_department_request(r.id,(SELECT id FROM actor))
  ) SELECT CASE WHEN EXISTS (
      SELECT 1 FROM workspace_members m WHERE m.workspace_id=p_workspace_id AND m.user_id=(SELECT id FROM actor)
    ) THEN greatest(0,floor(extract(epoch FROM (min(boundary)-clock_timestamp()))*1000))::integer
      ELSE 0 END FROM boundaries
$$;

COMMIT;
