BEGIN;
-- [COMP:api/crm-integration-auth] Exact parent attestation without exposing OAuth rows.
CREATE FUNCTION public.crm_oauth_parent_current(
  parent_id uuid, workspace uuid, actor uuid, client text, expiry timestamptz, fingerprint text
) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.oauth_authorizations a
    JOIN public.oauth_clients c ON c.client_id=a.client_id
    WHERE a.id=parent_id AND a.workspace_id=workspace AND a.user_id=actor AND a.client_id=client
      AND a.scope='read_write' AND a.revoked_at IS NULL AND c.revoked_at IS NULL
      AND a.access_token_expires_at>clock_timestamp()
      AND date_trunc('milliseconds',a.access_token_expires_at)=expiry
      AND a.access_token_hash IS NOT NULL
      AND encode(sha256(convert_to(to_jsonb(a.access_token_hash)::text,'UTF8')),'hex')=fingerprint
    FOR SHARE OF a,c
  );
$$;
COMMIT;
