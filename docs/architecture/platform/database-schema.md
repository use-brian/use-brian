# Organization cutover schema additions

The preceding schema is defined by the immutable migrations in
`packages/api/migrations/`. The organization cutover specification is
`docs/plans/complete-organization-cutover.md`.

| Migration | Schema behavior |
| --- | --- |
| `8148_department_mode_admission.sql` | Adds `classic_mode_admission_required(uuid)` and routes the superseded creation/session/setup admission selectors through it. V2 department enforcement remains active independently of setup completion; the flag-off model retains its existing admission protocol. No department RLS, source/parent check, immutable snapshot or configured-connector receipt is disabled. |
| `8149_organization_cutover.sql` | Adds owner/session-bound organization cutover reviews, a policy completion receipt FK and a deferred atomic-apply check. Extends the existing schedule immutability guard only for a live reviewed conversion from NULL authoring snapshot to the exact unchanged workflow authority. All non-binding job fields and current saved actor/assistant must match; no dispatcher claim is minted. |

| `8150_department_office_publication.sql` | Extends immutable Office snapshot publication to session-bound v2 generation jobs. Retains the live job, parent ACL, file envelope, content hash and storage path checks. |
