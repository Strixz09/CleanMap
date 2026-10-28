# CleanMap community features: deployment and security setup

> **Missing API objects on an existing project:** use the guarded repair and audit gates in [community-api-repair.md](community-api-repair.md). The original rollout below changes base policies/schema and must not be rerun blindly. The repair draft preserves those settings and still awaits the full live audit.

## What is implemented

The existing HTML/CSS/vanilla JavaScript application now has editable public profiles, avatar previews/uploads/removal, Google/Facebook sign-in buttons, email password recovery, author links, owner/admin feedback controls, and a paginated Explore directory. The existing report dialog, map, uploads, voting thresholds, and local-report path are retained. No frontend framework, Node server, or production fixture records are added. Node is used only by the existing browser-test tooling.

## Inspected configuration and limits

- Supabase project: `zezcbpmmhpwzlbuafsby`.
- API: `https://zezcbpmmhpwzlbuafsby.supabase.co`.
- Supabase OAuth callback: **`https://zezcbpmmhpwzlbuafsby.supabase.co/auth/v1/callback`**.
- Intended production site supplied by the owner: **`https://cleanmap-chi.vercel.app/`**. It returned HTTP 404 during inspection on 2026-10-21. Restore/verify this deployment before testing production authentication.
- Local site: `http://localhost:3000/` (also explicitly allows `http://127.0.0.1:3000/`).
- Public Auth settings showed email enabled, email confirmation required, and Google/Facebook disabled. No provider credentials were available or changed.
- Anonymous REST probes were denied for `profiles`, `reports`, `feedback`, and `report_votes`. The code preserves this authenticated report-access model. The migration does **not** make reports, feedback, votes or report-media buckets public.
- The repository previously contained only `admin_status_security.sql`. The full live schema, RLS, grants, auth triggers, Storage rules, and `is_admin()` implementation could not be retrieved using the public client. Do not treat the local fixture tests as verification of production policies.

## 1. Audit before applying the migration

1. Back up the database through Supabase's backup tools. Confirm the target project ID above.
2. Run `supabase/audit.sql` in the Supabase SQL Editor. It returns one JSON cell containing schema/security metadata, without account or report records. Review/export that cell; the commented bucket-settings query can be run separately. For missing views/RPCs, follow `docs/database-contract.md` before applying SQL. A compatible live repair requires inspecting this actual schema result.
3. Confirm the existing columns used by the app:
   - `profiles`: UUID `id`, server-managed `role`; possibly other private fields.
   - `reports`: `id`, `reporter_id`, `location`, `pollution_type`, `severity`, `description`, `latitude`, `longitude`, `photo_url`, `video_url`, `created_at`, `verification_status`.
   - `feedback`: `id`, `report_id`, `user_id`, `message`, `created_at`.
   - `report_votes`: `id`, `report_id`, `user_id`, `severity`.
4. Verify `public.is_admin()` derives its result from a trusted database role, uses a fixed safe search path, and cannot be changed by ordinary users. Check all existing SECURITY DEFINER functions and auth-user triggers for unrestricted role/profile writes. Client metadata must never assign an admin role. The migration does not replace the existing admin authority.
5. Check existing owner/admin write policies and read visibility. In particular, feedback editing/deletion will be available only if the existing permissive policies and grants authorize it. New restrictive policies constrain those permissions; they do not expand them. Report-attached feedback is intentionally readable by all authenticated users; retain that visibility and restrict submission to the caller's identity.
6. Inspect `profiles` dependencies, column grants, and auth triggers. The migration revokes client access to the full private table and permits authenticated clients to read only their own `id,role`. Public fields move behind an explicit view. Ensure no other application depends on fetching private profile fields directly.
7. Resolve existing case-insensitive username collisions, invalid existing public-field lengths/formats, or duplicate `(report_id,user_id)` votes **without inventing ownership or discarding records**. If they exist, the migration fails atomically; review them manually first.
8. Inspect legacy report-media policies. Signed URLs retain existing access restrictions. Do not make `cleanmap-media` public to fix a missing thumbnail.

## 2. Apply the reviewed migration once

Run `supabase/migrations/20261021_community.sql` in SQL Editor after the audit. It is a single transaction. A missing prerequisite, incompatible schema, conflicting constraint or incompatible existing avatar bucket aborts the transaction. It is intended to run once, not be replayed after a successful application. Keep a record of the applied migration.

Changes:

- Adds missing `profiles.username, display_name, bio, avatar_url, city, barangay, created_at` columns. Does not change IDs, roles, email, or established profile values. Public join date prefers the authenticated account's real creation time.
- Enforces a case-insensitive unique username and public field size/format constraints. New profiles may leave the username unset until customized.
- Exposes only the intended public fields through `cleanmap_public_profiles`; private account fields and role are excluded.
- Adds `cleanmap_ensure_profile()` and `cleanmap_save_profile(...)`. Both require `auth.uid()` and have a fixed empty search path. Initialization uses the existing authenticated ID and `ON CONFLICT DO NOTHING`, so repeat sign-ins preserve a customized profile. Only display name and HTTPS avatar metadata are considered; role/email are not copied into public fields.
- Adds optional `reports.city` and `reports.barangay`. No legacy geography or authorship is guessed or backfilled. The app asks submitters to enter known areas, and leaves unknown areas unassigned. Existing coordinates/location text are retained.
- Adds restrictive ownership policies and write guards: report/feedback/vote inserts take the authenticated identity, author relationships cannot be reassigned, and report verification changes require the established admin check.
- Adds future foreign-key checks with `NOT VALID`, preserving legacy orphan rows. Audit those rows before separately validating constraints; do not assign an owner without reliable evidence. Existing foreign-key delete behavior is retained.
- Creates the public **`cleanmap-avatars`** bucket (JPEG, up to 2 MB). Avatar objects are intentionally public. Upload/update/delete require the authenticated user's UUID folder, including restrictive guards against older broad Storage policies. The browser validates JPEG/PNG/WebP input, decodes it and re-encodes a square JPEG before upload. Existing report media stays private.
- Adds an RLS-respecting `security_invoker` directory view and read-only area/statistics functions. Their results inherit the caller's existing table permissions. Pagination is 12 per directory page; private media URLs are signed only for visible thumbnails/opened reports. The map starts with the latest 200 report metadata records and labels that limit; all accessible reports remain browsable in Explore. Statistics use server aggregate counts, not the number of downloaded cards.
- Adds query indexes and the one-vote-per-user/report unique index. Consensus remains at least three votes and 60% agreement.

If the audit reveals extra required profile columns without defaults, differing ID types, unsafe admin helpers, or missing read/write policies, stop and adapt the migration to that verified schema first. Do not remove checks to force it through. No production migration has been applied by this task.

## 3. Configure Supabase redirect URLs

In Supabase → Authentication → URL Configuration:

1. Set **Site URL** to `https://cleanmap-chi.vercel.app/` once that deployment is working.
2. Add these exact Redirect URLs:
   - `https://cleanmap-chi.vercel.app/`
   - `https://cleanmap-chi.vercel.app/?recovery=1`
   - `http://localhost:3000/`
   - `http://localhost:3000/?recovery=1`
   - `http://127.0.0.1:3000/`
   - `http://127.0.0.1:3000/?recovery=1`
3. Configure and test email delivery, confirmation and recovery templates. Recovery must use Supabase's generated recovery link, not a custom token placed in frontend code.
4. Production and local auth use PKCE with session persistence and the official existing Supabase browser client. Callbacks are processed at `/`; error/code parameters are removed after session handling. Only known local page names are restored. Arbitrary `next` URLs are not followed.
5. Preview domains are intentionally absent from `authRedirectURL()` in `community.js`. To test OAuth on a specific trusted Vercel preview, explicitly add that exact origin to the code allowlist and the matching exact redirect URLs in Supabase. Do not use a wildcard covering untrusted deployments.

### Email confirmation redirects and existing unconfirmed accounts

The signup handler always sends `emailRedirectTo: 'https://cleanmap-chi.vercel.app/'`, including when signup starts locally. OAuth and password-reset redirects retain the existing trusted local/production allowlist. Supabase's official v2 client automatically processes returned sessions and PKCE codes; the page must not exchange the same code a second time.

For the deployment owner:

1. In Vercel, restore the intended production deployment and attach **`cleanmap-chi.vercel.app`** to it. The supplied production URL returned HTTP 404 during this task; changing a redirect cannot repair a missing deployment. Verify `/` and `script.js` return HTTP 200 before testing another confirmation email.
2. In the Supabase project **`zezcbpmmhpwzlbuafsby`**, open **Authentication → URL Configuration**. Set **Site URL** to **`https://cleanmap-chi.vercel.app/`**. Add that exact URL to **Redirect URLs**, retaining the password-reset/local entries above if used. An unallowlisted requested redirect may fall back to the Site URL. Review obsolete preview URLs; the Site URL must not point to a deleted Vercel deployment. These Dashboard settings cannot be verified or changed through the frontend client.
3. In **Authentication → Email Templates → Confirm signup**, inspect the confirmation link. Use Supabase's generated **`{{ .ConfirmationURL }}`** for this standard flow. Remove any hardcoded obsolete deployment link. Do not replace it with a plain site link or `{{ .RedirectTo }}` alone: that would skip token verification. Do not change recovery/provider templates unnecessarily.
4. In **Authentication → Users**, check the existing account's confirmation state. Do not delete it or repeatedly sign it up. If already confirmed, sign in normally. Otherwise use an unexpired confirmation email, or resend once using the available Dashboard action after the rate limit has cleared. Previously sent links can retain their old redirect destination; changing code/settings does not rewrite them. Obtain a fresh link after correcting configuration. Delivery limits depend on Supabase's Auth/SMTP settings; do not hammer retries or disable confirmation to work around them.
5. For PKCE, start signup on the production website and open its email link in the **same browser and browser profile**, which stores the verifier. A signup started on localhost returns to production but cannot transfer localhost's verifier to that origin. Confirmation can verify the email without establishing a browser session; the page then offers sign-in guidance rather than claiming success. Users opening links on another device may also need to sign in after confirmation.
6. Test with an authorized new account: one signup, correct generated link destination, email confirmation, restored session or ordinary sign-in, sign-out, and existing-account sign-in. Test an expired link and the clear 429 message without sending repeated real requests. Do not claim email delivery or production authentication passed on the basis of isolated browser tests.

No database migration, RLS change, Storage change, or private credential is required for this redirect fix.

## 4. Google sign-in

1. Open Google Cloud Console and select/create the project that owns CleanMap's OAuth integration.
2. Configure the OAuth consent screen (Google Auth Platform → Branding/Audience/Data Access, or the equivalent current interface). Use your real app/support contact details. Add the required authorized domain and actual privacy-policy links when requested. Configure test users while the app is in Testing mode.
3. Create an OAuth client of type **Web application**.
4. Set its **Authorized redirect URI** to:
   `https://zezcbpmmhpwzlbuafsby.supabase.co/auth/v1/callback`
   This is the provider callback, not the CleanMap site URL. If the console requests JavaScript origins for your configuration, use the exact trusted application origin; the app itself uses Supabase's redirect-based flow, not a Google frontend client secret.
5. In Supabase → Authentication → Sign In / Providers → Google, enable Google and enter that client ID and client secret. Save them only in the provider dashboard configuration.
6. Save the Supabase redirect allowlist described above.
7. Test “Continue with Google” locally and on the actual production domain: consent, first session/profile creation, repeated sign-in preserving changes, cancellation/denial, and sign-out. Social users do not need a separate CleanMap password.
8. Complete Google's publishing/verification steps as required for your audience/scopes before opening access beyond test users. Do not request unnecessary scopes; only the provider identity needed by Supabase is used.

## 5. Facebook sign-in

1. In Meta for Developers, select/create an app with the **Facebook Login** use case appropriate for a consumer website. Follow Meta's current app-type/use-case requirements.
2. Configure Facebook Login for Web. Use the real CleanMap site URL and app domain (`cleanmap-chi.vercel.app`) where requested. Restore the 404 deployment first.
3. Set **Valid OAuth Redirect URIs** to:
   `https://zezcbpmmhpwzlbuafsby.supabase.co/auth/v1/callback`
   Enable the applicable client/web OAuth login settings and HTTPS requirements.
4. In Supabase → Authentication → Sign In / Providers → Facebook, enable the provider and enter the Meta App ID and App Secret. Store the secret only in Supabase's provider settings.
5. Use only the identity permissions needed for Supabase authentication (normally `public_profile` and `email`). Meta may require review/advanced access depending on app type and audience. A Facebook account may not provide an email; do not invent one or merge accounts by name—offer existing email sign-in when the provider cannot complete authentication.
6. Supply real privacy-policy and user-data deletion instructions/callback URLs required by Meta before switching to Live. These must be owner-approved published documents/endpoints, not invented links.
7. While the app is in **Development** mode, login is restricted to app roles (admins/developers/testers) and allowed test users. Add/accept tester roles before testing; an ordinary member may be denied even when the code is correct.
8. Complete Meta's required business/app review and permission checks, then switch to Live for the intended audience. Verify login again using a permitted account without an app role.
9. Test consent, cancellation/denial, first and repeated sessions, profile metadata availability, and production return URLs. Provider avatars may expire; the UI falls back to a default avatar and supports uploading a replacement.

CleanMap never matches accounts by display name or implements account merging. Profiles follow Supabase's authenticated UUID. Review Supabase's own verified-identity linking behavior and settings separately.

## 6. Deploy and verify

1. Apply the reviewed migration before publishing code that uses its views/RPCs.
2. Deploy the existing static repository through Vercel. No framework/build command is needed. Confirm the intended production alias points to the deployment and `/`, `community.js`, `community.css`, `script.js` return HTTP 200.
3. Verify the exact production origin in `community.js` and Supabase's redirect list. Do not place provider secrets or service-role keys in Vercel public/frontend variables or JavaScript.
4. Run `docs/testing.md` locally. Test fixtures are isolated and never uploaded to Supabase.
5. With two authorized test accounts and an admin account in a dedicated test project/environment, verify actual SQL/Storage RLS: another user's profile/role/avatar/report/feedback cannot be modified, identity fields cannot be forged, and only admin can verify reports. Verify legacy records are still available according to existing permissions.
6. Perform real email registration/confirmation/recovery and Google/Facebook login tests on localhost and production. Confirm first and repeat sign-in use one profile and retain existing content.
7. Upload/replace/remove an avatar, submit real authorized test reports/media, contribute/edit/delete feedback, vote, browse/filter/search/page Explore, open author profiles, and return to the directory with filters retained. Check desktop/mobile layouts, browser console and failed network requests.
8. Remove only the test accounts/content you intentionally created, using authorized cleanup procedures. Do not seed examples into real reports/statistics.

## Remaining manual gates

Live schema/RLS/admin-function audit; applying the migration; provider client/app creation and secrets; real domain deployment; allowed redirects; provider test/live settings; live authenticated security/OAuth/storage verification. The code and disposable tests cannot substitute for those gates.
