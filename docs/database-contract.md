# CleanMap database contract and missing-object diagnosis

## Current diagnosis

The community frontend added in commit `fe285ba85b83fb96115f154be91342dbfcaf61be` depends on `supabase/migrations/20261021_community.sql`. That file defines **both views and all four RPCs** listed below. This repository is a static website: deploying it to Vercel does not run SQL migrations. The implementation task did not apply a migration to the hosted project.

Read-only API probes on 2026-10-21 against `https://zezcbpmmhpwzlbuafsby.supabase.co` found:

| Object | Anonymous REST result, requesting zero records |
| --- | --- |
| `public.profiles`, `public.reports`, `public.feedback`, `public.report_votes` | HTTP 401, PostgreSQL `42501`: permission denied |
| `public.cleanmap_report_directory`, `public.cleanmap_public_profiles` | HTTP 404, `PGRST205`: missing from schema cache |
| OpenAPI schema discovery | HTTP 401: secret API key required |

The existing table responses show that `public` is recognized by the API. They do not disclose actual column definitions, grant permission to read records, or prove the community views are absent from PostgreSQL itself. The user's missing-RPC errors are consistent with the same deployment mismatch. The audit below is needed to distinguish an unapplied/rolled-back migration from an object/signature/exposure/cache problem. Do not provide a secret API key to the browser or relax RLS to obtain this information.

## Obtain the actual schema

In Supabase project **`zezcbpmmhpwzlbuafsby`**, run the whole updated `supabase/audit.sql` in SQL Editor as the project owner. It returns one `cleanmap_schema_audit` JSON cell. Export that cell, review function bodies for any embedded secrets, and provide the schema result plus any error from a previous migration attempt. No user/report/media rows are queried. The commented final query separately reports settings for the two relevant Storage buckets if needed.

The audit covers missing/existing relations; exact PostgreSQL column types, defaults, nullability and generated/identity attributes; enums; constraints and indexes; RLS policies; effective table grants and explicit column grants; triggers and their functions; function signatures/return types/security/execute grants; schema USAGE; and database-stored PostgREST exposure settings. It also reports whether the Supabase CLI migration-history table exists. SQL Editor execution may not create a CLI history entry, so migration history alone is not proof of application.

The script tolerates missing application tables and functions. It was tested inside READ ONLY transactions against empty, legacy-fixture and migrated-fixture PostgreSQL 17 databases. Those fixtures are not a copy of the hosted schema.

## Frontend contract: existing tables

All frontend database requests use Supabase's default **public** schema. Types below describe frontend needs, not unverified declarations of the live schema. Report IDs are treated as opaque IDs; their actual native type and related foreign keys must come from the audit. User identity references must agree with authenticated Supabase user IDs.

| Table | Columns referenced | Read/write usage |
| --- | --- | --- |
| `profiles` | `id`, `role` | Own-role lookup in `refreshCleanMapRole()`; frontend never writes role. Public profile fields are read through the dedicated view and edited through an RPC. |
| `reports` | `id`, `reporter_id`, `location`, `pollution_type`, `severity`, `description`, `latitude`, `longitude`, `photo_url`, `video_url`, `created_at`, `verification_status`, `city`, `barangay` | Counts by author; report details; authenticated insertion; authorized deletion; admin status update. Admin list and insertion response also use `select('*')`/`select()`; UI mapping consumes the listed fields. |
| `feedback` | `id`, `report_id`, `user_id`, `message`, `created_at` | Per-report and per-author feedback; counts; insert message with report/user relationship; authorized message edit/delete; admin moderation list. |
| `report_votes` | `id`, `report_id`, `user_id`, `severity` | Read current user's vote, read per-report/community votes, insert or update own vote. Duplicate prevention depends on the existing relationship/unique constraint as well as UI checks. |

Values consumed or produced by the UI:

- Severity: `low`, `moderate`, `high`, `severe`.
- Pollution type: `Air Pollution`, `Water Pollution`, `Solid Waste`, `Noise Pollution`.
- Verification status: `Pending verification`, `Verified`, `Rejected`.
- Coordinates must be convertible to finite numbers; timestamps must be parseable dates. SQL-native column types must be inspected before defining functions/views that depend on them.
- Feedback is trimmed, 1–280 characters. Missing legacy authors remain unassigned. No ownership/geography backfill is implied by this contract.
- `photo_url` and `video_url` normally contain paths in private `cleanmap-media`. The frontend also supports existing URL values. They must not be replaced with fabricated/public URLs during repair.

References: `script.js` voting, `submitCommunityNote()`, report submission/deletion, `mapCloudReport()`, `refreshCleanMapRole()`, admin functions; `community.js` profile counts/activity, `openCloudReport()`, feedback pagination/editing.

## Frontend contract: views

### `public.cleanmap_report_directory`

Used by `directoryQuery()` in `community.js`, then by map loading in `script.js`, Explore, and profile report lists. Exact selected columns (`DIRECTORY_FIELDS`):

```text
id, reporter_id, location, pollution_type, severity, reporter_severity,
description, latitude, longitude, photo_url, video_url, created_at,
verification_status, city, barangay, vote_counts, activity_count, severity_rank
```

- Base fields retain report values/types. `reporter_severity` is the original reported severity; `severity` is the effective community severity.
- `vote_counts` is a JSON object keyed by severity, with numeric counts. Missing keys are interpreted as zero by the UI.
- `activity_count` is a numeric total of visible votes and feedback; `severity_rank` is an integer from 1 to 4.
- Current migration consensus: at least **three votes** and **60%** agreement. Preserve those boundaries and the existing RLS visibility of source rows.
- Filters: type, effective severity, city, barangay, status, reporter ID; text search: location, description, city, barangay; sorting: creation date/ID, severity rank, activity count. Exact count and range pagination are required.
- Migration definition uses PostgreSQL 15+ `security_invoker=true`. Callers still need the appropriate underlying grants/RLS. Granting access to the view alone must not become a way around report, feedback or vote privacy.

### `public.cleanmap_public_profiles`

Exact selected columns (`PUBLIC_PROFILE_FIELDS`):

```text
id, username, display_name, bio, avatar_url, city, barangay, created_at
```

Used by author links, profile pages, and profile editing. `id` associates with the authenticated user; join date comes from `auth.users.created_at` in the migration. `username`, `display_name`, `bio`, avatar and location fields are the intended public projection. Email, role and arbitrary account metadata are excluded. The migration deliberately uses a restricted owner-executed projection to avoid granting public access to `auth.users` or private profile fields; audit its owner and definition rather than exposing the underlying tables.

## Frontend contract: RPCs

| Function and exact signature | Result in current migration | Caller / behavior |
| --- | --- | --- |
| `cleanmap_ensure_profile()` — no arguments | `void` | `initializeMemberProfile()` after session restoration. Initializes at most one own profile using `auth.uid()`; existing profile preserved. |
| `cleanmap_save_profile(p_username text, p_display_name text, p_bio text, p_city text, p_barangay text, p_avatar_url text)` | `void` | Profile editor sends these six named parameters. Updates own public fields; cannot supply an arbitrary user ID or role. |
| `cleanmap_report_areas()` — no arguments | `TABLE(city text, barangay text)` | `loadReportAreas()` expects an array of area pairs from accessible reports. |
| `cleanmap_report_statistics()` — no arguments | `jsonb` object | Map/statistics loading expects numeric `total`, `low`, `moderate`, `high`, `severe`, `areas`. Current `areas` counts distinct report `location` strings. |

The two profile RPCs use `SECURITY DEFINER` with an empty search path and authenticated identity checks; client EXECUTE is granted only to `authenticated`. Area/statistics RPCs use `SECURITY INVOKER` and preserve caller visibility. Avoid broad grants, duplicate overloads, renamed arguments, or `json`/unnamed-argument alternatives that do not match these calls.

## Other SQL and Storage dependencies

The migration also references:

- `auth.users.id`, `created_at`, `raw_user_meta_data`, and `auth.uid()`; these are database-side dependencies, not direct browser table reads.
- The existing trusted `public.is_admin()` and `profiles.role`; current SQL assumes an initializer-compatible default for mandatory profile fields. Preserve the established admin authority.
- `profiles.username`, `display_name`, `bio`, `avatar_url`, `city`, `barangay`, `created_at`; it adds missing public fields but does not accommodate unknown mandatory private fields automatically.
- `cleanmap_guard_identity()` triggers on reports, feedback and votes. Separately, `admin_status_security.sql` defines `cleanmap_guard_verification_status()` and its report trigger. Audit existing trigger behavior before changing either.
- `storage.buckets` metadata and `storage.objects.bucket_id/name`, `storage.foldername(name)`, bucket **`cleanmap-avatars`**. Avatar upload/getPublicUrl/remove are used by `community.js`; expected avatar settings are public JPEG up to 2 MB with owner-folder writes.
- Private bucket **`cleanmap-media`**: upload, signed URL creation and authorized deletion in `script.js`. Its privacy and existing policies must be retained. The community migration does not change that bucket's settings.

Favorites and the offline report/media path use browser storage, not another Supabase table. Auth operations use the existing Supabase Auth API. There are no further production database clients or server migration runners in this repository; `tests/` contains isolated fixtures, not deployed data.

## Decide the repair from the audit

1. **Objects absent in PostgreSQL:** inspect prerequisites and any original error, then prepare/apply the compatible versioned migration. A schema-cache reload cannot create absent objects.
2. **Objects partially present:** compare definitions, signatures, ownership and grants. Prepare a forward migration for the missing/incompatible objects. Do not blindly rerun the broad community migration: its plain `CREATE` statements and named constraints/policies are intentionally not an idempotent repair script.
3. **All definitions present and correct:** check Supabase Dashboard **Data API / API Settings → Exposed schemas** includes `public`, and check schema USAGE and object privileges for the intended role. Keep existing authenticated-only report access. Empty `postgrest_database_settings` in the audit is inconclusive because managed configuration can live outside database settings.
4. **Correct objects/exposure/grants but stale REST cache:** the owner can execute `NOTIFY pgrst, 'reload schema';` after the DDL transaction commits, then recheck the exact REST requests. The current migration already sends this notification; it is delivered only on successful commit. A SQL Editor result does not by itself prove the running API cache refreshed.
5. **RPC exists under a different signature:** compare zero-argument routines and the six named text parameters above. Review conflicting overloads; do not drop unknown functions or dependents to force a match.

The existing migration can roll back on missing/disabled RLS, a missing `is_admin()`, incompatible ID/severity types, a mandatory profile field without a default, existing username/vote conflicts, incompatible avatar settings, or existing object names. These are possible causes, not diagnoses of the live schema. Its preflight checks cover only some dependencies; a passing synthetic fixture is insufficient evidence of live compatibility.

After the actual schema is supplied, validate the specific repair in a disposable PostgreSQL database matching that schema. Check exact view/RPC result types, preservation of rows, own-profile and admin permissions, source-row visibility through the directory/statistics, duplicate voting, and private-media access. Then obtain the owner's approval for the concrete live schema change and verify authenticated REST/browser requests after application. This diagnostic update does not apply a migration or claim shared reports are fixed.
