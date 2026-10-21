# Restore the missing community API objects

## Status and root cause

Project: **`zezcbpmmhpwzlbuafsby`**. Production: **https://cleanmap-chi.vercel.app/**.

The owner reports that the database audit confirms both community views and all four RPCs are absent. The deployed JavaScript requires all six. This explains the missing-resource errors (`PGRST205`, `PGRST202`, HTTP 404): the frontend and database API are out of sync. Vercel serves the static files; it does **not** execute the SQL in this repository. Reloading PostgREST cannot create absent objects.

The original `20261021_community.sql` defines all six, but also changes base columns, constraints, policies, triggers and avatar storage. It may never have run or may have rolled back. The absence summary cannot establish which occurred. Do not blindly rerun that broad migration.

**Full audit review remains blocked.** Only the six-object absence summary is available in this workspace, not the column, grant, constraint, trigger, policy and Storage definitions. The new `supabase/migrations/2026102101_restore_community_api.sql` is a locally tested, guarded draft for manual review. It is not yet verified against the live schema and must not be applied until the audit is compared. No live SQL or Dashboard configuration has been changed. No frontend changes are needed for the inspected API contract.

## Actual callers and SQL contract

| Object | Actual caller | Required response |
| --- | --- | --- |
| `cleanmap_public_profiles` | `community.js`: `fetchPublicProfiles()`, `PUBLIC_PROFILE_FIELDS` | Eight public fields: `id,username,display_name,bio,avatar_url,city,barangay,created_at` |
| `cleanmap_report_directory` | `community.js`: `directoryQuery()`, `DIRECTORY_FIELDS`; used by map, Explore and profile lists | Report fields, original/effective severity, JSON vote counts, numeric activity count and severity rank; all 19 selected columns |
| `cleanmap_ensure_profile()` | `community.js`: `initializeMemberProfile()` | No arguments; `void` |
| `cleanmap_save_profile(text,text,text,text,text,text)` | `community.js`: `saveProfile()` | Named parameters `p_username,p_display_name,p_bio,p_city,p_barangay,p_avatar_url`; `void` |
| `cleanmap_report_areas()` | `community.js`: `loadReportAreas()` | Rows with `city text, barangay text` |
| `cleanmap_report_statistics()` | `community.js`: `loadCloudStatistics()`; `script.js`: `loadCloudReports()` | JSONB numeric keys `total,low,moderate,high,severe,areas` |

See [database-contract.md](database-contract.md) for every base-table column and Storage dependency. Local tests compare actual view columns and RPC signatures against the JavaScript, including the six named save parameters. Severity output supports existing text or enum source columns; three votes and 60% agreement remain the consensus rule.

## Required audit comparison before execution

Run the read-only `supabase/audit.sql` in the target project's SQL Editor. Export the `cleanmap_schema_audit` JSON and inspect it, including separately requested bucket settings. Review function bodies for embedded credentials before sharing. This audit reads schema metadata, not user/report records.

Confirm:

- PostgreSQL 15+; `public` exposed through the Data API; appropriate existing schema USAGE and source-table SELECT grants for authenticated users. Invoker views cannot bypass missing grants.
- All required base columns/types exist, including the profile public fields and report `city,barangay`. The repair deliberately aborts instead of adding missing base fields.
- `profiles.id` is UUID with an existing unique key; an existing unique index on `lower(username)` enforces case-insensitive uniqueness. Unknown mandatory fields, generated fields, constrained string lengths, domains and defaults need review against initialization/update inputs. The automated preflight is not a substitute for that review.
- Profile insert/update triggers and defaults are compatible. Existing profiles are left intact; new initialization uses `auth.uid()` and no client-supplied role. The additional admin-default guard does not replace an audit of the trusted `is_admin()` and auth triggers.
- Existing profile grants/RLS prevent reading private fields or changing another user's data/role. The owner-executed public view intentionally exposes only the eight listed public fields and the account join date; it bypasses base RLS for that projection. Email, role and arbitrary metadata are excluded. Confirm these eight fields are intended to be public.
- Report/feedback/vote RLS and identity triggers enforce ownership and admin-only verification. Report feedback remains readable by **all authenticated users**; submission must use the caller's ID, and read access must not confer edit/delete access. No feedback policy is changed by the repair.
- `cleanmap-media` stays private with its existing ownership policies and signed-URL access. The repair never touches Storage tables, grants or buckets. Avatar operations separately require the existing `cleanmap-avatars` bucket and owner-folder policies; a missing avatar bucket needs a separately reviewed change.

If any prerequisite is absent or unsafe, stop and adapt a separate concrete proposal to the audit. Do not disable RLS, grant broad access, drop constraints, delete records or run the original migration to get past a check.

## What the guarded repair does

- Creates only missing API views/functions and their required grants in one transaction. Existing compatible definitions are skipped. Different definitions, overloads, owners or client privileges cause rollback; they are not overwritten.
- Preserves base data, columns, indexes, constraints, policies, triggers and grants. Creates no users, report fixtures, Storage objects or migration-history records.
- Uses an empty function search path and explicit schema qualification. The two profile functions use `SECURITY DEFINER`, authenticated identity, validated public fields and own-avatar paths; only `authenticated` receives client execution permission.
- Uses `security_invoker=true` for the directory and invoker RPCs for areas/statistics, retaining the caller's source-row visibility. Public profile SELECT is intentional; reports and all four RPCs remain authenticated-only.
- Sends `NOTIFY pgrst, 'reload schema'` only on successful commit. Short lock/statement timeouts and an advisory transaction lock prevent an indefinitely blocked or concurrent repair.

Idempotence is conservative: rerunning this exact repair is tested, including a partially missing API. A semantically equivalent but differently defined existing object may be rejected for review. It does not silently normalize existing permissions. Follow the single-transaction instructions; do not execute isolated blocks.

## Manual Supabase and Vercel checklist

1. Obtain/review the full audit and resolve the compatibility checklist above. Confirm the target project ID and an available backup. Save the pre-change audit.
2. **Only after compatibility review**, open SQL Editor as the database owner and run the complete `supabase/migrations/2026102101_restore_community_api.sql`. This is the proposed repair file; do not apply all historical migrations. Save the result/error. An error rolls back the entire repair; if executing interactively and the session remains aborted, issue `ROLLBACK;` before investigating.
3. Run `supabase/audit.sql` again. Confirm the two views, four exact signatures, intended grants/security options, and unchanged base policies/triggers/Storage settings. Do not fabricate a `supabase_migrations` history row; retain the SQL/result in your deployment record.
4. If definitions now exist but REST errors persist, run `NOTIFY pgrst, 'reload schema';` as a standalone statement after commit. Check **Data API / API Settings → Exposed schemas** includes `public`. Verify exact RPC names/named arguments and intended-role permissions. Retry once after cache reload. Do not expose `auth` or `storage` schemas or add broad grants to clear an API error.
5. In Vercel, confirm the intended CleanMap deployment is assigned to **`cleanmap-chi.vercel.app`** and `/`, `/script.js`, `/community.js` return HTTP 200. Promote/redeploy the approved source revision through the existing workflow if needed. There is no Node server or migration build command to add. SQL-only repair does not require new frontend assets. A `DEPLOYMENT_NOT_FOUND` response is a separate deployment/domain issue.
6. Keep the production URL, Supabase project configuration and Auth URL allowlist unchanged. Do not put a service-role key or OAuth secret in frontend variables. Follow existing email/OAuth setup in [community-setup.md](community-setup.md) if callbacks remain unconfigured.
7. Execute the live checks below using authorized accounts. Do not report production fixed based solely on successful SQL execution or local simulations.

## Live acceptance checklist (not yet performed)

- Signed out: intended public profile fields readable; private profile fields, reports and RPCs remain denied according to the existing authenticated access model.
- Sign in with an existing member: map markers/shared reports and Explore load; no `PGRST205`, `PGRST202` or missing-area 404. Existing records, filtering, pagination, favorites and detail selection still work.
- Profiles: repeated session initialization retains one profile; edit your own profile and open another public profile. Attempts to change another profile or set an admin role fail. Upload/replace/remove an authorized test avatar; another user cannot modify it.
- Areas/statistics: city/barangay options come from accessible real records; statistics agree with the same records and effective severity. No synthetic reports enter production totals.
- Feedback/votes: two authorized members can read the same report feedback; neither can impersonate or modify the other's feedback. Existing duplicate-vote limits and consensus thresholds hold. Confirm owner edit/delete and admin moderation with approved test content.
- Admin: regular members cannot verify/reject reports; the established admin can. Existing ownership/deletion permissions remain intact.
- Media/authentication: existing private photos/videos load only for intended users; existing upload/signed-URL flow works. Test sign-out/sign-in and restored sessions. No bucket privacy change is necessary.
- Browser: desktop/mobile localhost and the actual deployed URL; no new console/network errors, blank map or lost navigation state. Use the same approved backend setup and no fabricated data.

## Validation performed and limits

`python3 tests/community-api-migration.py` passes against disposable PostgreSQL 17 with synthetic Supabase roles/schema. It checks installation/repeat/partial repeat, exact frontend columns and RPC signatures, unchanged records/security/Storage snapshots, authenticated and anonymous access, own-profile updates, admin protection, all-member feedback reading, identity/ownership enforcement, private media, directory/statistics RLS, vote thresholds, and text/enum severity types. It verifies atomic refusal of missing columns, unsupported mandatory fields, missing uniqueness, disabled RLS, conflicting views/RPC overloads and unexpected column privileges.

The fixture uses the original migration to model an already prepared base schema, then removes the six API objects. It is **not** an export of the production database. Existing frontend test passes are reused because no frontend file changed. Live schema compatibility, hosted REST, Auth, Storage and production browser acceptance remain unverified until the full audit is reviewed and the owner manually applies the reviewed SQL.
