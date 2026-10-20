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
