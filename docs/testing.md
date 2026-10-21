# Browser regression checks

Serve the repository with `python3 -m http.server 3000 --bind 0.0.0.0`. The app has no build step or package dependencies to install.

`tests/browser-regression.cjs` connects to an **existing** Chromium browser over CDP using Playwright Core. It does not launch or install a browser. Provide a resolvable `playwright-core` installation, or set `CLEANMAP_PLAYWRIGHT_MODULE` to its module path. In the Coding Agent sandbox, register the static preview first and get its browser endpoint with `coderabbit-agent-browser get cdp-url`.

```bash
CLEANMAP_BROWSER_CDP='<existing CDP endpoint>' node tests/browser-regression.cjs
```

The suite checks the real Leaflet map at desktop, tablet, and two phone sizes; both coastline tips and padding; tiles; real MapTiler search; preservation of location selection through tabs/resizing; zoom; simulated GPS; all eight guidance choices; draft preservation in the guide; photo/video selection; map-click pin selection; and reverse geocoding.

It then tests the existing offline report path with a synthetic local observation, marker colors, local voting, statistics, profile, legacy favorites, admin access denial, and account mode switching. Each run uses a new temporary browser context and blocks all Supabase network requests. No fixtures reach real reports or statistics. The context is closed even on failure. GPS is simulated, video selection does not test media playback, and signed-in Supabase/admin workflows are not certified by this suite.

Optional: `CLEANMAP_TEST_URL=https://cleanmaps.vercel.app/ CLEANMAP_TEST_CANDIDATE=1` runs the same candidate under the deployed origin, overriding only the repository's HTML/CSS/JS/image responses in that isolated browser context. This verifies origin-sensitive map/search behavior, **not** deployment of the new files. Without those overrides, the remote site must already serve the candidate version.

For visual verification and accessibility, use the registered shared preview with `coderabbit-agent-browser screenshot` and `coderabbit-agent-browser a11y --tags wcag2a,wcag2aa --json`.

## Report-details dashboard

With the same CDP/module environment, run `node tests/report-details.cjs` for focused dialog coverage. It checks marker/profile-card entry, desktop/phone/tablet/landscape layout, visible voting, fixed header and internal scrolling, Escape and map preservation, keyboard focus, duplicate/replacement votes and threshold boundaries, feedback, photo and playable synthetic video, media cleanup, deletion confirmations, and owner/member/admin action visibility. Feedback's Supabase payload and sign-in/failure behavior are checked with an in-browser stub; this does not certify live RLS permissions. All test reports/media are confined to a temporary browser context. The same optional Vercel-origin resource overrides are supported.

## Profiles, social-auth contracts, and Explore

Run `node tests/community.cjs` with the same `CLEANMAP_BROWSER_CDP` and `CLEANMAP_PLAYWRIGHT_MODULE` environment as above. It injects `tests/fixtures/community-client.js` **only into a new isolated browser context**, blocks hosted Supabase, and closes the context afterward. It checks UI/API contracts for profiles/avatars, author links, feedback edits/deletes, pagination/geographic filters, safe rendering, email/reset/provider actions, redirects, session changes, and responsive layout. It simulates provider sessions; it does not certify an actual Google/Facebook exchange or hosted Supabase permissions.

For SQL security validation, use a fresh disposable PostgreSQL 15+ database, never the real project. Run these files in order with `psql -v ON_ERROR_STOP=1`:

1. `tests/security-fixture.sql` — reconstructs the schema used by this app and deliberately broad pre-existing write policies.
2. `supabase/migrations/20261021_community.sql` — actual migration.
3. `tests/security-regression.sql` — impersonation/ownership/privacy/uniqueness/Storage/admin assertions executed under real PostgreSQL roles.

The fixture creates synthetic identities and records in that disposable database only. It is not a production schema export. Destroy/recreate the test database before repeating the three-file sequence. Production setup and remaining live validation gates are in `docs/community-setup.md`.

## Email confirmation and rate limits

Run `node tests/auth-confirmation.cjs` with the same CDP/module environment. It uses the official CDN Supabase v2 client and intercepts all Supabase requests in isolated browser contexts. It verifies the exact production `redirect_to`, single in-flight signup and loading/reset behavior, 429 handling without retry, existing/unconfirmed-account sign-in, PKCE callback exchange/session persistence, expired/error links, missing verifier guidance and password recovery. Production-origin candidate assets are intercepted from this checkout, so this does **not** prove deployment, email delivery, live credentials, or Dashboard configuration. No real signup/email/record is created.
