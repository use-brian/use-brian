BEGIN;

-- INSERT ... RETURNING evaluates SELECT RLS against the new row. A STABLE
-- security-definer parent lookup cannot see that row in the statement snapshot.
-- Test its held bit directly; child policies still need the parent lookup.
ALTER POLICY recording_privacy_read ON sessions
  USING (NOT recording_privacy_held);

COMMIT;
