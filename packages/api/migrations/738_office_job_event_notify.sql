BEGIN;

-- Office job progress reaches the browser by push (office.md "Live job
-- progress"). Every event row and every status/stage/error change publishes an
-- id-only pointer; the per-job stream re-reads the rows through the access
-- projection. NOTIFY is delivered at commit, so a listener never sees a seq
-- before its row is visible, and the triggers cover every writer.

CREATE FUNCTION notify_office_job_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('office_job_events', json_build_object(
    'jobId', NEW.job_id, 'workspaceId', NEW.workspace_id, 'seq', NEW.seq)::text);
  RETURN NULL;
END $$;

CREATE TRIGGER office_generation_events_notify
  AFTER INSERT ON office_generation_events
  FOR EACH ROW EXECUTE FUNCTION notify_office_job_event();

CREATE FUNCTION notify_office_job_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('office_job_events', json_build_object(
    'jobId', NEW.id, 'workspaceId', NEW.workspace_id, 'seq', NULL)::text);
  RETURN NULL;
END $$;

CREATE TRIGGER office_generation_jobs_notify
  AFTER UPDATE OF status, stage, error_code ON office_generation_jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
     OR OLD.stage IS DISTINCT FROM NEW.stage
     OR OLD.error_code IS DISTINCT FROM NEW.error_code)
  EXECUTE FUNCTION notify_office_job_status();

COMMIT;
