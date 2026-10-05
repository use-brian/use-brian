-- Owner-private metadata only; connections are not native action authority.
CREATE TABLE computer_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 enabled_assistant_ids uuid[] NOT NULL DEFAULT '{}',
 assistant_routing_notes jsonb NOT NULL DEFAULT '{}',
 device_id text,
 connection_id uuid,
 connection_auth_session_id uuid REFERENCES auth_sessions(id) ON DELETE SET NULL,
 connection_expires_at timestamptz,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX computer_profiles_owner_name ON computer_profiles(workspace_id,owner_user_id,name) WHERE deleted_at IS NULL;
ALTER TABLE native_computer_sessions ADD COLUMN profile_id uuid REFERENCES computer_profiles(id) ON DELETE SET NULL;
ALTER TABLE native_computer_sessions ADD COLUMN connection_id uuid;
ALTER TABLE native_computer_sessions ADD CHECK (profile_id IS NULL OR task_id IS NULL);
CREATE TABLE computer_profile_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES computer_profiles(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 tool_name text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','denied','ended','released')),
 session_id uuid REFERENCES native_computer_sessions(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Only an intentional known-idle release permits fresh consent in the same chat.
-- Keep retired rows as audit history; denial/ended requests remain sticky.
CREATE UNIQUE INDEX computer_profile_chat_request ON computer_profile_requests(profile_id,connection_id,conversation_id) WHERE state <> 'released';
CREATE UNIQUE INDEX computer_profile_pending ON computer_profile_requests(profile_id) WHERE state='pending';
-- No broad workspace-member policy: only the authenticated owner sees metadata.
ALTER TABLE computer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE computer_profile_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_profiles_owner ON computer_profiles USING (owner_user_id = current_setting('app.current_user_id',true)::uuid);
CREATE POLICY computer_profile_requests_owner ON computer_profile_requests USING (user_id = current_setting('app.current_user_id',true)::uuid);
