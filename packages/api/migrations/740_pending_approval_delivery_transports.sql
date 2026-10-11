BEGIN;

-- Approval prompts may be delivered on every transport with a proactive push
-- (unified-sessions L15, plan section 4.6). The recent-channel resolver already
-- resolved Microsoft Teams and Feishu targets, which this CHECK rejected, so
-- those approvals failed at INSERT. The allowed set is now exactly
-- `PROACTIVE_DELIVERY_TRANSPORTS` in packages/api/src/session-kind.ts, plus
-- `web` (the in-app approvals queue).

ALTER TABLE pending_approvals DROP CONSTRAINT IF EXISTS pending_approvals_delivery_channel_type_check;
ALTER TABLE pending_approvals ADD CONSTRAINT pending_approvals_delivery_channel_type_check
  CHECK (delivery_channel_type = ANY (ARRAY['web','telegram','slack','whatsapp','feishu','msteams','custom']));

COMMIT;
