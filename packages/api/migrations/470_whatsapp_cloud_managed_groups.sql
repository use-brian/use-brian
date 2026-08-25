-- Durable ledger for groups created through the official WhatsApp Cloud API.
BEGIN;

CREATE TABLE public.whatsapp_cloud_managed_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  request_id TEXT UNIQUE,
  provider_group_id TEXT UNIQUE,
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
  invite_link TEXT,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'active', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_cloud_managed_groups_channel_idx
  ON public.whatsapp_cloud_managed_groups (channel_id, created_at);

CREATE TRIGGER whatsapp_cloud_managed_groups_set_updated_at
  BEFORE UPDATE ON public.whatsapp_cloud_managed_groups
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.whatsapp_cloud_managed_groups ENABLE ROW LEVEL SECURITY;

-- Selecting through channels applies the same membership and clearance policy
-- as every other channel-owned row.
CREATE POLICY whatsapp_cloud_managed_groups_channel_member
  ON public.whatsapp_cloud_managed_groups
  USING (channel_id IN (SELECT id FROM public.channels))
  WITH CHECK (channel_id IN (SELECT id FROM public.channels));

COMMIT;
