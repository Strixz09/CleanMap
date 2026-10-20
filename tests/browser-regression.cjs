/* Run against an already-running shared Chromium session; never launches a browser.
 * See docs/testing.md. Fixtures live only in a fresh temporary browser context.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.CLEANMAP_PLAYWRIGHT_MODULE || 'playwright-core');
const baseURL = process.env.CLEANMAP_TEST_URL || 'http://localhost:3000/';
const endpoint = process.env.CLEANMAP_BROWSER_CDP;
assert(endpoint, 'Set CLEANMAP_BROWSER_CDP to the running browser CDP endpoint.');
const candidateOverride = process.env.CLEANMAP_TEST_CANDIDATE === '1';
const root = path.resolve(__dirname, '..');
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

(async () => {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', geolocation: { latitude: 10.3157, longitude: 123.8854, accuracy: 20 }, permissions: ['geolocation'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // No real Supabase requests, accounts or reports may be created by this suite.
    await context.route('**/*.supabase.co/**', route => route.abort());
    if (candidateOverride) {
        const origin = new URL(baseURL).origin;
        await context.route(`${origin}/**`, async route => {
            const url = new URL(route.request().url());
            const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            if (['index.html', 'style.css', 'design.css', 'script.js', 'guides.js', 'welcome-screen.png'].includes(file)) {
                await route.fulfill({ path: path.join(root, file), headers: { 'cache-control': 'no-store' } });
            } else await route.continue();
        });
    }
    try {
        await page.goto(baseURL, { waitUntil: 'networkidle' });
        assert.equal(await page.evaluate(() => cleanMapInstance), null, 'Map is deferred while welcome hides it');
        assert.equal(await page.locator('[data-impact-guide] .guide-card').count(), 8);
        // The first view must exist synchronously, before the next layout frame.
        const initialView = await page.evaluate(() => {
            document.getElementById('welcomeScreen').hidden = true;
            document.getElementById('appShell').hidden = false;
            initRealMap();
            const view = {
                zoom: cleanMapInstance.getZoom(),
                contains: cleanMapInstance._loaded && cleanMapInstance.getBounds().contains(CEBU_ISLAND_BOUNDS),
                updating: cleanMapLayoutUpdating
            };
            if (Number.isFinite(view.zoom) && view.contains) {
                reports.push({ id: 'initial-selection', location: 'Regression-only initial selection', lat: 11.15, lng: 123.95, severity: 'low' });
                selectLocation('initial-selection');
            }
            return view;
        });
        assert(Number.isFinite(initialView.zoom) && initialView.contains, 'Map has an island view immediately after initialization');
        assert.equal(initialView.updating, false, 'Initialization releases the layout guard');
        await page.waitForFunction(() => !cleanMapInstance._panAnim?._inProgress);
        await settle(page);
        const immediateSelection = await page.evaluate(() => ({
            distance: cleanMapInstance.latLngToContainerPoint([11.15, 123.95]).distanceTo(cleanMapInstance.getSize().divideBy(2)),
            zoom: cleanMapInstance.getZoom(), overview: cleanMapOverviewActive
        }));
        assert(immediateSelection.distance <= 1, 'Selection before the next layout frame retains its location');
        assert.equal(immediateSelection.zoom, initialView.zoom);
        assert.equal(immediateSelection.overview, false);
        console.log('PASS synchronous map initialization and immediate report selection');
        // Discard the in-memory fixture before exercising the normal welcome flow.
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('#welcomeSignIn').click();
        await page.locator('#accountDialogClose').click();
        await page.waitForFunction(() => cleanMapInstance?._loaded && !cleanMapOverviewPending);
        await page.waitForFunction(() => [...document.querySelectorAll('#realMap .leaflet-tile')].some(tile => tile.complete && tile.naturalWidth));
        for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [320, 780]]) {
            await page.setViewportSize({ width, height });
            await settle(page);
            await page.waitForFunction(() => cleanMapLastSize?.[0] === document.getElementById('realMap').clientWidth);
            await page.waitForFunction(() => {
                const area = document.getElementById('realMap').getBoundingClientRect();
                const visible = [...document.querySelectorAll('#realMap .leaflet-tile')].filter(tile => {
                    const box = tile.getBoundingClientRect();
                    return box.right > area.left && box.left < area.right && box.bottom > area.top && box.top < area.bottom;
                });
                return visible.length > 0 && visible.every(tile => tile.complete && tile.naturalWidth > 0);
            });
            const view = await page.evaluate(() => {
                const map = cleanMapInstance;
                const north = map.latLngToContainerPoint(CEBU_ISLAND_BOUNDS[1]);
                const south = map.latLngToContainerPoint(CEBU_ISLAND_BOUNDS[0]);
                return { contains: map.getBounds().contains(CEBU_ISLAND_BOUNDS), north: north.y, south: south.y, height: map.getSize().y, zoom: map.getZoom(), overflow: document.documentElement.scrollWidth > innerWidth };
            });
            assert(view.contains && view.north >= 20 && view.south <= view.height - 20, `Both tips fit with padding at ${width}px`);
            assert(!view.overflow, `No horizontal overflow at ${width}px`);
            console.log('PASS island overview', width, 'zoom', view.zoom);
        }
        // Use the existing live MapTiler geocoder, not a fabricated search result.
        await page.locator('#searchInput').fill('Daanbantayan, Cebu');
        await page.locator('#searchButton').click();
        await page.waitForFunction(() => cleanMapInstance.getCenter().lat > 11 && cleanMapInstance.getZoom() === 14 && !cleanMapInstance._animatingZoom);
        const selectedView = await page.evaluate(() => ({ lat: cleanMapInstance.getCenter().lat, lng: cleanMapInstance.getCenter().lng, zoom: cleanMapInstance.getZoom() }));
        await page.locator('[data-page="statistics"]').click();
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator('[data-page="map"]').click();
        await settle(page);
        const returnedView = await page.evaluate(() => ({ lat: cleanMapInstance.getCenter().lat, lng: cleanMapInstance.getCenter().lng, zoom: cleanMapInstance.getZoom() }));
        assert(Math.abs(selectedView.lat - returnedView.lat) < .0001 && Math.abs(selectedView.lng - returnedView.lng) < .0001);
        assert.equal(returnedView.zoom, selectedView.zoom);
        await page.locator('#zoomIn').click();
        await page.waitForFunction(() => cleanMapInstance.getZoom() === 15 && !cleanMapInstance._animatingZoom);
        await page.locator('#zoomOut').click();
        await page.waitForFunction(() => cleanMapInstance.getZoom() === 14 && !cleanMapInstance._animatingZoom);
        // Network, parse, and HTTP failures all show the same community-facing copy.
        for (const failure of ['network', 'json', 'http']) {
            const pattern = '**/geocoding/**';
            await page.route(pattern, route => failure === 'network'
                ? route.abort('failed')
                : route.fulfill({ status: failure === 'http' ? 503 : 200, contentType: 'application/json', body: 'not JSON' }));
            try {
                await page.locator('#searchInput').fill(`Regression search failure ${failure}`);
                const warningPromise = page.waitForEvent('console', { predicate: message => message.type() === 'warning' && message.text().startsWith('CleanMap location search failed:') });
                await page.locator('#searchButton').click();
                const warning = await warningPromise;
                assert.equal(await warning.args()[1].evaluate(error => error.name), failure === 'network' ? 'TypeError' : failure === 'json' ? 'SyntaxError' : 'Error', 'Raw search error is logged');
                await page.waitForFunction(() => document.getElementById('toast').textContent === 'Location search is unavailable. Please try again.');
            } finally {
                await page.unroute(pattern);
            }
        }
        // Editing an input without submitting another search must also stale its error.
        for (const failure of ['network', 'json', 'http']) {
            const pattern = '**/geocoding/**';
            let intercept;
            const intercepted = new Promise(resolve => { intercept = resolve; });
            await page.route(pattern, route => { intercept(route); });
            try {
                await page.locator('#searchInput').fill(`Regression stale failure ${failure}`);
                await page.locator('#searchButton').click();
                const route = await intercepted;
                const requestId = await page.evaluate(() => mapSearchRequest);
                await page.locator('#searchInput').fill(failure === 'http' ? '' : 'An edited query');
                const warningPromise = page.waitForEvent('console', { predicate: message => message.type() === 'warning' && message.text().startsWith('CleanMap location search failed:') });
                if (failure === 'network') await route.abort('failed');
                else await route.fulfill({ status: failure === 'http' ? 503 : 200, contentType: 'application/json', body: 'not JSON' });
                await warningPromise;
                assert.equal(await page.evaluate(() => mapSearchRequest), requestId, 'Editing did not submit another search');
                assert.equal(await page.locator('#toast').innerText(), 'Searching for that place…', 'Stale failure does not replace the status for an edited or cleared query');
            } finally {
                await page.unroute(pattern);
            }
        }
        console.log('PASS controlled active-search failures, raw diagnostics, and suppressed stale errors for edited/cleared queries');
        await page.locator('#locationButton').click();
        await page.waitForFunction(() => window.userLocationMarker?.getLatLng().lat === 10.3157);
        console.log('PASS live search, preserved view after tab/resize, zoom, simulated map GPS');

        await page.locator('[data-page="report"]').click();
        const typeCopy = await page.evaluate(() => CLEANMAP_GUIDES.types);
        for (const [value, guide] of Object.entries(typeCopy)) {
            await page.locator('#reportType').selectOption(value);
            const text = await page.locator('#typeGuidance').innerText();
            assert(text.includes(guide.label) && text.includes(guide.description));
            guide.examples.forEach(example => assert(text.includes(example)));
            if (guide.note) assert(text.includes(guide.note));
        }
        const severityCopy = await page.evaluate(() => CLEANMAP_GUIDES.severities);
        for (const [value, guide] of Object.entries(severityCopy)) {
            await page.locator(`[name="severity"][value="${value}"]`).check();
            const text = await page.locator('#severityGuidance').innerText();
            assert(text.includes(guide.label) && text.includes(guide.description));
            guide.examples.forEach(example => assert(text.includes(example)));
            if (guide.note) assert(text.includes(guide.note));
        }
        assert.equal(await page.locator('[data-severity-guide] .guide-card').count(), 4);
        const draft = 'Regression-only local observation. Never sent to the cloud.';
        await page.locator('#reportDescription').fill(draft);
        await page.locator('[data-open-guide="types"]').click();
        assert(await page.locator('#guidelinesDialog').isVisible());
        assert.equal(await page.locator('#guidelinesContent .guide-card').count(), 4);
        await page.locator('[data-guide-mode="severity"]').click();
        assert((await page.locator('#guidelinesContent').innerText()).includes('Do not select Severe based only'));
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#reportDescription').inputValue(), draft);
        assert.equal(await page.locator('#reportType').inputValue(), 'Noise Pollution');
        assert(await page.locator('#noiseVideoField').isVisible());
        const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64');
        await page.locator('#reportPhoto').setInputFiles({ name: 'local-test.png', mimeType: 'image/png', buffer: photo });
        await page.waitForFunction(() => document.getElementById('photoPreview').naturalWidth > 0);
        await page.locator('#reportVideo').setInputFiles({ name: 'local-test.webm', mimeType: 'video/webm', buffer: Buffer.from('synthetic-file-selection-only') });
        assert(await page.locator('#videoPreviewWrap').isVisible());
        await page.locator('#removeVideoButton').click();
        assert(!(await page.locator('#videoPreviewWrap').isVisible()));
        await page.locator('#reportType').selectOption('Solid Waste Pollution');
        await page.locator('[name="severity"][value="high"]').check();
        await page.locator('#reportGpsButton').click();
        await page.waitForFunction(() => document.getElementById('locationPickerDialog').open && pendingPickedCoordinates?.lat === 10.3157);
        // Exercise an actual Leaflet click in the picker before confirming the pin.
        const picker = page.locator('#locationPickerMap');
        const beforePick = await page.evaluate(() => ({ ...pendingPickedCoordinates }));
        await picker.click({ position: { x: 160, y: 160 } });
        await page.waitForFunction(before => pendingPickedCoordinates &&
            (pendingPickedCoordinates.lat !== before.lat || pendingPickedCoordinates.lng !== before.lng), beforePick);
        const chosen = await page.evaluate(() => ({ ...pendingPickedCoordinates }));
        await page.locator('#confirmPickedLocation').click();
        await page.waitForFunction(() => !document.getElementById('locationPickerDialog').open);
        assert((await page.locator('#reportLocation').inputValue()).length > 0);
        console.log('PASS all category/severity copy, draft preservation, photo/video UI, GPS/picker/reverse geocoding');

        // Exercise the already-existing offline report path in an isolated context.
        await page.evaluate(() => { supabaseClient = null; });
        await page.locator('#reportForm button[type="submit"]').click();
        await page.waitForFunction(() => reports.length === 1 && Boolean(reportMarkers[reports[0].id]));
        const report = await page.evaluate(() => ({ severity: reports[0].severity, type: reports[0].type, lat: reports[0].lat, lng: reports[0].lng, photo: Boolean(reports[0].photo), color: reportMarkers[reports[0].id].options.fillColor, expected: severityColor('high') }));
        assert.equal(report.severity, 'high');
        assert.equal(report.type, 'Solid Waste Pollution');
        assert.equal(report.lat, chosen.lat);
        assert.equal(report.lng, chosen.lng);
        assert(report.photo);
        assert.equal(report.color, report.expected);
        assert.equal(await page.evaluate(() => cleanMapInstance.getZoom()), 15, 'Submitting keeps the report location view');
        assert((await page.locator('#severityGuidance').innerText()).includes('Choose a severity level'));
        await page.locator('[data-vote-severity="low"]').click();
        assert.equal(await page.evaluate(() => reports[0].myVote), 'low');
        await page.locator('[data-vote-severity="high"]').click();
        assert.deepEqual(await page.evaluate(() => [reports[0].votes.low, reports[0].votes.high]), [0, 1]);
        await page.locator('#closeDetails').click();
        await page.locator('[data-page="statistics"]').click();
        assert.equal(await page.locator('#totalReports').innerText(), '1');
        assert.equal(await page.locator('#chartHigh').innerText(), '1');
        await page.locator('[data-page="profile"]').click();
        assert.equal(await page.locator('#myReportCount').innerText(), '1');
        // A legacy favorite-capable location is added only in this temporary context.
        await page.evaluate(() => {
            locations.push({ id: 1, name: 'Regression-only local place', severity: 'low', level: 'Low', type: 'Solid Waste Pollution', description: 'Synthetic browser fixture', updated: 'Today' });
            switchPage('map'); selectLocation(1);
        });
        await page.locator('#favoriteButton').click();
        assert.equal(await page.evaluate(() => favorites.length), 1);
        await page.locator('#favoriteButton').click();
        assert.equal(await page.evaluate(() => favorites.length), 0);
        await page.locator('#closeDetails').click();
        await page.evaluate(() => switchPage('admin'));
        assert(await page.locator('#page-map').isVisible());
        assert(!(await page.locator('#adminNavButton').isVisible()));
        await page.evaluate(() => document.getElementById('accountDialog').showModal());
        await page.locator('#accountModeSwitch').click();
        assert(await page.locator('#accountDisplayName').isVisible());
        await page.locator('#accountModeSwitch').click();
        assert(!(await page.locator('#accountDisplayName').isVisible()));
        await page.locator('#accountDialogClose').click();
        await page.evaluate(() => localStorage.setItem('cleanmapWelcomeSeen', 'true'));
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(() => cleanMapInstance?._loaded && !cleanMapOverviewPending && reports.length === 1 && Boolean(reportMarkers[reports[0].id]));
        assert(await page.evaluate(() => cleanMapInstance.getBounds().contains(CEBU_ISLAND_BOUNDS)), 'Returning visitor still starts with the island overview');
        assert.equal(await page.evaluate(() => reports[0].severity), 'high');
        assert.deepEqual(errors, [], 'No browser JavaScript errors');
        console.log('PASS isolated local submission, marker colors, vote changes, statistics, profile, favorites, admin gate, account modes, returning-visitor markers');
        console.log(`PASS ${baseURL}${candidateOverride ? ' (candidate resources overridden locally; not a deployment)' : ''}`);
    } finally {
        await context.close();
        await browser.close(); // Disconnects CDP; does not stop the shared browser.
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
