-- CRM R2 foundation: relationship activity, bounded configuration, operator saved
-- views, and multi-contact deals. CRM records remain entity-backed.
-- Spec: docs/architecture/features/crm.md -> "CRM R2 product contract".

BEGIN;

-- Composite references below make workspace partitioning a database
-- invariant rather than relying on each writer to repeat it correctly.
ALTER TABLE entities
  ADD CONSTRAINT entities_workspace_id_unique UNIQUE (workspace_id, id);

CREATE TABLE crm_pipelines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  is_default   BOOLEAN NOT NULL DEFAULT false,
  position     INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX crm_pipelines_one_default
  ON crm_pipelines (workspace_id) WHERE is_default;
CREATE INDEX crm_pipelines_workspace_position
  ON crm_pipelines (workspace_id, position, created_at);

CREATE TABLE crm_pipeline_stages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pipeline_id     UUID NOT NULL,
  name            TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  legacy_key      TEXT CHECK (legacy_key IS NULL OR legacy_key IN
                    ('lead','qualified','proposal','negotiation','won','lost')),
  category        TEXT NOT NULL CHECK (category IN ('open','won','lost')),
  position        INTEGER NOT NULL CHECK (position >= 0),
  probability     INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  required_fields TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, name),
  UNIQUE (pipeline_id, position),
  FOREIGN KEY (workspace_id, pipeline_id)
    REFERENCES crm_pipelines(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX crm_pipeline_stages_workspace
  ON crm_pipeline_stages (workspace_id, pipeline_id, position);

CREATE TABLE crm_field_definitions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('person','company','deal')),
  field_key    TEXT NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label        TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  field_type   TEXT NOT NULL CHECK (field_type IN
                 ('text','number','date','boolean','single_select','multi_select')),
  options      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  is_required  BOOLEAN NOT NULL DEFAULT false,
  position     INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  archived_at  TIMESTAMPTZ,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_kind, field_key)
);
CREATE INDEX crm_field_definitions_live
  ON crm_field_definitions (workspace_id, entity_kind, position)
  WHERE archived_at IS NULL;

CREATE TABLE crm_activities (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id          UUID NOT NULL,
  activity_type      TEXT NOT NULL CHECK (activity_type IN
                       ('note','call','meeting','message','field_change','stage_change')),
  direction          TEXT NOT NULL DEFAULT 'internal'
                       CHECK (direction IN ('inbound','outbound','internal')),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject            TEXT,
  summary            TEXT NOT NULL DEFAULT '',
  source_kind        TEXT,
  source_id          TEXT,
  actor_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_assistant_id UUID REFERENCES assistants(id) ON DELETE SET NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((source_kind IS NULL) = (source_id IS NULL)),
  FOREIGN KEY (workspace_id, entity_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX crm_activities_timeline
  ON crm_activities (workspace_id, entity_id, occurred_at DESC, id DESC);
CREATE UNIQUE INDEX crm_activities_source_once
  ON crm_activities (workspace_id, entity_id, source_kind, source_id)
  WHERE source_kind IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE crm_saved_views (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  section      TEXT NOT NULL CHECK (section IN ('deals','contacts','companies','reports')),
  query_state  JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(query_state) = 'object'),
  position     INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_user_id, name)
);
CREATE INDEX crm_saved_views_owner_position
  ON crm_saved_views (workspace_id, owner_user_id, position, created_at);

CREATE TABLE crm_deal_contacts (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id      UUID NOT NULL,
  contact_id   UUID NOT NULL,
  role         TEXT,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, contact_id),
  FOREIGN KEY (workspace_id, deal_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES entities(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX crm_deal_contacts_contact
  ON crm_deal_contacts (workspace_id, contact_id, deal_id);
CREATE UNIQUE INDEX crm_deal_contacts_one_primary
  ON crm_deal_contacts (deal_id) WHERE is_primary;

CREATE TRIGGER crm_pipelines_updated_at
  BEFORE UPDATE ON crm_pipelines FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER crm_pipeline_stages_updated_at
  BEFORE UPDATE ON crm_pipeline_stages FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER crm_field_definitions_updated_at
  BEFORE UPDATE ON crm_field_definitions FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER crm_saved_views_updated_at
  BEFORE UPDATE ON crm_saved_views FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- The R2 configuration/history tables follow the existing workspace-member
-- policy plus the system-worker bypass. Saved views add a creator boundary.
ALTER TABLE crm_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY crm_pipelines_member ON crm_pipelines
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY crm_pipeline_stages_member ON crm_pipeline_stages
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY crm_field_definitions_member ON crm_field_definitions
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY crm_activities_member ON crm_activities
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));
CREATE POLICY crm_saved_views_owner ON crm_saved_views
  USING (owner_user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (owner_user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY crm_deal_contacts_member ON crm_deal_contacts
  USING (workspace_id IN (SELECT workspace_id FROM workspace_members
    WHERE user_id = current_setting('app.current_user_id', true)::uuid));

CREATE POLICY crm_pipelines_system ON crm_pipelines
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');
CREATE POLICY crm_pipeline_stages_system ON crm_pipeline_stages
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');
CREATE POLICY crm_field_definitions_system ON crm_field_definitions
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');
CREATE POLICY crm_activities_system ON crm_activities
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');
CREATE POLICY crm_saved_views_system ON crm_saved_views
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');
CREATE POLICY crm_deal_contacts_system ON crm_deal_contacts
  USING (COALESCE(current_setting('app.system_bypass', true), 'true') = 'true');

-- Seed the compatibility pipeline for every existing workspace. New
-- workspaces are seeded lazily and transactionally by ensureCrmDefaultPipeline.
INSERT INTO crm_pipelines (workspace_id, name, is_default, position)
SELECT id, 'Sales', true, 0 FROM workspaces;

INSERT INTO crm_pipeline_stages
  (workspace_id, pipeline_id, name, legacy_key, category, position, probability)
SELECT p.workspace_id, p.id, v.name, v.legacy_key, v.category, v.position, v.probability
FROM crm_pipelines p
CROSS JOIN (VALUES
  ('Lead',        'lead',        'open', 0,   10),
  ('Qualified',   'qualified',   'open', 1,   30),
  ('Proposal',    'proposal',    'open', 2,   60),
  ('Negotiation', 'negotiation', 'open', 3,   80),
  ('Won',         'won',         'won',  4,  100),
  ('Lost',        'lost',        'lost', 5,    0)
) AS v(name, legacy_key, category, position, probability)
WHERE p.is_default;

UPDATE entities e
SET attributes = COALESCE(e.attributes, '{}'::jsonb) || jsonb_build_object(
  'pipeline_id', p.id,
  'pipeline_stage_id', s.id,
  'currency_code', COALESCE(NULLIF(e.attributes->>'currency_code', ''), 'USD')
)
FROM crm_pipelines p
JOIN crm_pipeline_stages s ON s.pipeline_id = p.id
WHERE e.kind = 'deal'
  AND e.workspace_id = p.workspace_id
  AND p.is_default
  AND s.legacy_key = COALESCE(NULLIF(e.attributes->>'stage', ''), 'lead');

INSERT INTO crm_deal_contacts (workspace_id, deal_id, contact_id, is_primary)
SELECT workspace_id, id, (attributes->>'contact_id')::uuid, true
FROM entities
WHERE kind = 'deal'
  AND valid_to IS NULL
  AND attributes->>'contact_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;

COMMIT;
