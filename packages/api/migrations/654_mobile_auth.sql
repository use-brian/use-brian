-- Separate from desktop: exact client/redirect/S256 binding checked before consume.
CREATE TABLE mobile_auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL CHECK (client_id IN ('brian-ios', 'brian-android')),
  redirect_uri TEXT NOT NULL CHECK (redirect_uri = 'usebrian-mobile://auth'),
  challenge TEXT NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ
);
CREATE INDEX mobile_auth_codes_expiry_idx ON mobile_auth_codes (expires_at);
