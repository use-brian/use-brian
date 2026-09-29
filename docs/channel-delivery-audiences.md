# Channel delivery audiences

Studio > Channels exposes **Delivery audience** on integrated messaging channels.
This is a frontend for the existing owner/admin-only channel config PATCH API,
not a change to delivery authorization.

An approval binds one exact provider conversation ID to an audience type,
maximum sensitivity, Team compartment keys, Project UUIDs, optional individual
recipient user UUID and optional expiry. Telegram-private broadcast channels are
still group audiences. Group approvals cannot authorize user-private sources;
those require a verified personal recipient. No approval permits only public,
unrestricted output for an otherwise unverified external audience.

Owners/admins can add, edit and remove approvals. Members can inspect the saved
settings but cannot edit. New approvals default to group/public with no Team or
Project grants. Saving requires explicit audience authorization confirmation;
removing an approval requires confirmation too. The server owns version and
approval metadata. PATCH payloads strip those read-only fields from every entry
and retain all other destinations because the API replaces the complete list.
The API stamps only new or changed bindings with the current approver/time.
Unchanged entries retain their server-owned approval metadata, so editing or
removing another destination cannot reactivate an approval from a demoted admin.
Reapproving an unchanged policy requires explicitly removing and adding it;
no-op saves do not renew consent.

The editor validates duplicate destinations, known provider/audience mismatches
for Telegram, Slack and WhatsApp, UUIDs, list limits and future ISO timestamps.
Overlapping whole-chat and Telegram topic/discussion approvals are rejected:
the backend's first-match resolution must not silently shadow a topic policy. Changing to group removes
any individual recipient. Failed saves keep the draft, never show a success, and
can be retried. A refreshed binding list during editing blocks stale saves until
the editor is reopened. Backend authorization remains authoritative on role
changes. Existing per-channel settings continue to use their own PATCH fields.

The editor offers named destination, Project and individual-recipient pickers,
while preserving manual IDs and unlisted existing grants. Destinations come from
the current integration's seen-chat inventory (including Telegram topics) and
only discovered destinations explicitly attributed to that integration. Unknown
or different integration ownership is never guessed. Options reload when an
editor is opened; late results are discarded after close or identity changes.
Lookup failures retain manual entry and show a localized warning. Team compartment
keys remain an explicit advanced field because the Team registry intentionally
does not expose a safe compartment-key mapping. ISO expiry retains its explicit
timezone rather than silently interpreting a user-entered date in browser time.

Config errors retain HTTP status, machine code and validation field identifiers
in the SDK. The editor gives localized sign-in, permission, missing-integration,
and field-validation guidance, without rendering arbitrary server details. The
webhook-owned WhatsApp display phone number is excluded from writable config.

See [Workflow delivery feedback](workflow-delivery-feedback.md) for visible run
outcomes and links from workflow and schedule delivery setup.

All copy is localized in English, Japanese, Traditional and Simplified Chinese.
Tests: `[COMP:app-web/channel-delivery-audiences]`, including API payloads, role
boundaries, confirmation cancellation, validation, failure and refresh behavior.
