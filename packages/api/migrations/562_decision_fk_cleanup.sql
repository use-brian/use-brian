-- Referential cleanup is not an evidence rewrite. Keep the shared immutable
-- trigger (also used by feed revisions/receipts) strict; only decision tables
-- with SET NULL foreign keys get this narrowly scoped exception.
BEGIN;

CREATE FUNCTION reject_decision_update_except_fk_cleanup()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog
-- Fail closed instead of mistaking an RLS-hidden parent for a deleted parent.
SET row_security = off
AS $$
DECLARE
  before_row jsonb := to_jsonb(OLD);
  after_row jsonb := to_jsonb(NEW);
  fk record;
  parent_exists boolean;
BEGIN
  -- A direct UPDATE must never clear provenance, even if it only sets a FK
  -- to NULL. Referential actions run inside the parent DELETE's trigger.
  IF pg_trigger_depth() > 1 THEN
    FOR fk IN
      SELECT child.attname AS child_column, c.confrelid::regclass AS parent_table,
             parent.attname AS parent_column,
             format_type(parent.atttypid, parent.atttypmod) AS parent_type
      FROM pg_constraint c
      JOIN pg_attribute child ON child.attrelid = c.conrelid AND child.attnum = c.conkey[1]
      JOIN pg_attribute parent ON parent.attrelid = c.confrelid AND parent.attnum = c.confkey[1]
      WHERE c.conrelid = TG_RELID AND c.contype = 'f' AND c.confdeltype = 'n'
        AND cardinality(c.conkey) = 1 AND cardinality(c.confkey) = 1
    LOOP
      IF before_row -> fk.child_column IS DISTINCT FROM after_row -> fk.child_column THEN
        IF before_row -> fk.child_column <> 'null'::jsonb
           AND after_row -> fk.child_column = 'null'::jsonb THEN
          -- Depth alone is not authorization: another application trigger may
          -- issue updates too. Require the referenced parent to be gone.
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1::%s)',
                         fk.parent_table, fk.parent_column, fk.parent_type)
            INTO parent_exists USING before_row ->> fk.child_column;
          IF NOT parent_exists THEN
            before_row := before_row - fk.child_column;
            after_row := after_row - fk.child_column;
          END IF;
        END IF;
      END IF;
    END LOOP;
    IF before_row = after_row AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER decision_events_reject_update ON decision_events;
CREATE TRIGGER decision_events_reject_update
  BEFORE UPDATE ON decision_events
  FOR EACH ROW EXECUTE FUNCTION reject_decision_update_except_fk_cleanup();
DROP TRIGGER decision_applications_reject_update ON decision_applications;
CREATE TRIGGER decision_applications_reject_update
  BEFORE UPDATE ON decision_applications
  FOR EACH ROW EXECUTE FUNCTION reject_decision_update_except_fk_cleanup();

COMMIT;
