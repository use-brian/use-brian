BEGIN;

CREATE FUNCTION guard_scope_review_history_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.created_at) THEN
    RAISE EXCEPTION 'scope_review_anchor_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_scope_review_history_anchor BEFORE UPDATE ON workspace_scope_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_scope_review_history_anchor();

DROP INDEX workspace_scope_reviews_history;
CREATE INDEX workspace_scope_reviews_history ON workspace_scope_reviews(workspace_id,created_at DESC,id DESC);

COMMIT;
