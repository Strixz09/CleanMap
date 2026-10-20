/* Focused dialog regressions in an isolated context of the shared browser.
 * No real Supabase traffic or shared-data mutations. See docs/testing.md.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.CLEANMAP_PLAYWRIGHT_MODULE || 'playwright-core');
const baseURL = process.env.CLEANMAP_TEST_URL || 'http://localhost:3000/';
const root = path.resolve(__dirname, '..');
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

(async () => {
    assert(process.env.CLEANMAP_BROWSER_CDP, 'Provide the existing shared browser CDP endpoint.');
    const browser = await chromium.connectOverCDP(process.env.CLEANMAP_BROWSER_CDP);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*.supabase.co/**', route => route.abort());
    await context.addInitScript(() => localStorage.setItem('cleanmapWelcomeSeen', 'true'));
    if (process.env.CLEANMAP_TEST_CANDIDATE === '1') {
        await context.route(`${new URL(baseURL).origin}/**`, async route => {
            const url = new URL(route.request().url());
            const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            if (['index.html', 'style.css', 'design.css', 'script.js', 'guides.js', 'welcome-screen.png'].includes(file)) {
                await route.fulfill({ path: path.join(root, file), headers: { 'cache-control': 'no-store' } });
            } else await route.continue();
        });
    }
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const dialog = page.locator('#reportDetailsDialog');
    const close = async () => {
        await page.locator('#closeDetails').click();
        await page.waitForFunction(() => !document.getElementById('reportDetailsDialog').open && selectedLocation === null);
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'hidden');
    };
    const view = () => page.evaluate(() => ({ center: cleanMapInstance.getCenter(), zoom: cleanMapInstance.getZoom() }));
    try {
        await page.goto(baseURL, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => cleanMapInstance?._loaded && !cleanMapOverviewPending);
        await page.evaluate(() => {
            supabaseClient = null;
            reports = [{ id: 'dialog-fixture', location: 'Local regression location', type: 'Water Pollution', severity: 'moderate', reporterSeverity: 'moderate',
                description: 'A local fixture for dialog verification.\n'.repeat(80), date: '2026-10-20', lat: 10.35, lng: 123.9,
                votes: { low: 0, moderate: 0, high: 0, severe: 0 }, myVote: '', notes: [], cloudReport: false, verificationStatus: 'Pending verification' }];
            renderReportMarkers(); updateProfile();
        });
        // A real SVG marker click must enter the existing renderer.
        await page.locator('#realMap .leaflet-interactive').click();
        await page.waitForFunction(() => document.getElementById('reportDetailsDialog').open && !cleanMapInstance._panAnim?._inProgress);
        assert.equal(await page.locator('#reportDetailsTitle').innerText(), 'Local regression location');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'closeDetails');
        assert.equal(await dialog.locator('.report-details-media').count(), 0, 'No blank media panel');
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'hidden');
        const backgroundScroll = await page.evaluate(() => scrollY);
        await page.mouse.move(5, 990);
        await page.mouse.wheel(0, 500);
        await settle(page);
        assert.equal(await page.evaluate(() => scrollY), backgroundScroll, 'Backdrop wheel cannot scroll the page');
        for (let i = 0; i < 16; i++) {
            await page.keyboard.press('Tab');
            assert(await dialog.evaluate(el => el.contains(document.activeElement)), `Keyboard focus stays in the dialog (Tab ${i + 1})`);
        }

        for (const [width, height] of [[1440, 1000], [900, 700], [768, 1024], [390, 844], [320, 780], [844, 390]]) {
            await page.setViewportSize({ width, height });
            await settle(page);
            await page.locator('#reportDetailsScroll').evaluate(el => el.scrollTop = 0);
            const geometry = await dialog.evaluate(el => {
                const box = el.getBoundingClientRect();
                const header = el.querySelector('.report-details-header').getBoundingClientRect();
                const scroll = el.querySelector('.report-details-scroll');
                const vote = el.querySelector('.vote-panel-heading').getBoundingClientRect();
                return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
                    headerBottom: header.bottom, voteTop: vote.top, voteBottom: vote.bottom, overflow: document.documentElement.scrollWidth > innerWidth,
                    scrollOverflow: scroll.scrollWidth > scroll.clientWidth, columns: getComputedStyle(el.querySelector('.report-details-layout')).gridTemplateColumns,
                    outerScroll: el.scrollHeight > el.clientHeight + 1 };
            });
            assert(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= width && geometry.bottom <= height, `Dialog fits ${width}x${height}`);
            if (width >= 900) {
                assert(geometry.width >= width * .75 && geometry.width <= width * .9);
                assert(geometry.height <= height * .9);
            }
            assert(!geometry.overflow && !geometry.scrollOverflow && !geometry.outerScroll, `Single scroll area/no horizontal overflow at ${width}`);
            assert(geometry.voteTop >= geometry.headerBottom && geometry.voteTop < geometry.bottom, `Voting visible immediately at ${width}`);
            await page.locator('#reportDetailsScroll').evaluate(el => el.scrollTop = el.scrollHeight);
            const closeBox = await page.locator('#closeDetails').boundingBox();
            assert(closeBox.y >= 0 && closeBox.y + closeBox.height <= height, 'Header close stays visible');
            assert(await page.locator('.report-description').isVisible());
            assert(await page.evaluate(() => document.getElementById('reportDetailsScroll').scrollTop > 0), 'Long content scrolls internally');
        }
        console.log('PASS marker opening, desktop/mobile/landscape geometry, visible voting, fixed header, single scrolling, no empty media');
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.locator('#reportDetailsScroll').evaluate(el => el.scrollTop = 0);
        await page.locator('[data-vote-severity="high"]').click();
        assert.equal(await page.evaluate(() => document.activeElement.dataset.voteSeverity), 'high', 'Vote refresh retains keyboard focus');
        await page.locator('[data-vote-severity="high"]').click();
        assert.equal(await page.evaluate(() => renderVoteSummary(reports[0]).total), 1, 'Duplicate vote is not added');
        await page.locator('[data-vote-severity="low"]').click();
        assert.deepEqual(await page.evaluate(() => [reports[0].votes.high, reports[0].votes.low]), [0, 1]);
        assert.match(await page.locator('.vote-stat-row').first().innerText(), /1 · 100%/);
        const thresholds = await page.evaluate(() => [[0, 0, 2, 0], [1, 0, 2, 0], [1, 1, 2, 0], [2, 0, 3, 0]].map(counts => renderVoteSummary({ votes: Object.fromEntries(VOTE_LEVELS.map((level, i) => [level, counts[i]])) }).verified));
        assert.deepEqual(thresholds, [false, true, false, true], 'Existing 3 vote / 60% thresholds remain');
        await page.locator('.community-feedback summary').click();
        await page.locator('[name="communityNote"]').fill('Local-only feedback for this dialog regression.');
        await page.locator('[data-note-form] button').click();
        await page.waitForFunction(() => document.querySelectorAll('.community-notes-list blockquote').length === 1);
        await page.locator('#reportDetailsScroll').evaluate(el => el.scrollTop = 200);
        const beforeRefresh = await page.locator('#reportDetailsScroll').evaluate(el => el.scrollTop);
        await page.evaluate(() => selectLocation(reports[0].id));
        assert.equal(await page.locator('#reportDetailsScroll').evaluate(el => el.scrollTop), beforeRefresh);
        const beforeClose = await view();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => selectedLocation === null && !document.getElementById('reportDetailsDialog').open);
        assert.deepEqual(await view(), beforeClose, 'Closing preserves map camera');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'realMap', 'Detached opener returns focus to the map');
        console.log('PASS voting, duplicate prevention, replacement, threshold boundaries, feedback, refresh scroll/focus, Escape and map retention');

        await page.locator('#searchInput').fill('Local regression location');
        await page.locator('#searchButton').click();
        assert(await dialog.isVisible(), 'Existing report search opens the same dialog');
        await close();
        // Reopen from the existing profile card, then inspect photo and both video paths.
        await page.locator('[data-page="profile"]').click();
        await page.locator('[data-view-report="dialog-fixture"]').click();
        assert(await dialog.isVisible());
        await close();
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#123b31'; ctx.fillRect(0, 0, 640, 360);
            reports[0].photo = canvas.toDataURL('image/png');
            const stream = canvas.captureStream(10);
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            const chunks = [];
            recorder.ondataavailable = event => chunks.push(event.data);
            const recorded = new Promise(resolve => recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })));
            recorder.start();
            const timer = setInterval(() => { ctx.fillStyle = '#36d68a'; ctx.fillRect(10, 10, 40, 40); }, 50);
            await new Promise(resolve => setTimeout(resolve, 350));
            clearInterval(timer); recorder.stop();
            const blob = await recorded; stream.getTracks().forEach(track => track.stop());
            await saveVideoBlob('dialog-video', blob);
            reports[0].videoKey = 'dialog-video';
            selectLocation(reports[0].id);
        });
        await page.waitForFunction(() => document.querySelector('#detailsCard img')?.naturalWidth === 640 && document.querySelector('#detailsCard video')?.readyState >= 1);
        await page.locator('#detailsCard video').evaluate(async video => { video.muted = true; await video.play(); });
        assert(await page.locator('#detailsCard video').evaluate(video => !video.paused), 'Stored video can play');
        await page.setViewportSize({ width: 390, height: 844 });
        await settle(page);
        assert(await page.locator('#reportDetailsScroll').evaluate(el => el.scrollWidth <= el.clientWidth), 'Photo and video fit mobile dialog width');
        await page.setViewportSize({ width: 1440, height: 1000 });
        const oldVideo = await page.locator('#detailsCard video').elementHandle();
        await close();
        assert(await oldVideo.evaluate(video => video.paused), 'Closing pauses media');
        await page.evaluate(async () => {
            reports[0].videoUrl = URL.createObjectURL(await getVideoBlob('dialog-video'));
            delete reports[0].videoKey;
            selectLocation(reports[0].id);
        });
        await page.waitForFunction(() => document.querySelector('#detailsCard video')?.readyState >= 1);
        await close();
        console.log('PASS profile-card opening, photo, IndexedDB video playback, URL video, pause-on-close');

        // Keep the existing permission predicate and confirmation flow in use.
        await page.evaluate(() => {
            reports[0].cloudReport = true; reports[0].reporterId = 'private-owner';
            delete reports[0].videoUrl;
            currentUser = { id: 'different-member' }; currentRole = 'member';
            selectLocation(reports[0].id);
        });
        assert.equal(await page.locator('#deleteSelectedReport').count(), 0);
        assert(!(await dialog.innerText()).includes('private-owner'), 'Reporter identity is not exposed');
        await close();
        await page.evaluate(() => { currentUser = { id: 'private-owner' }; selectLocation(reports[0].id); });
        assert(await page.locator('#deleteSelectedReport').isVisible());
        assert((await dialog.innerText()).includes('You'));
        await close();
        await page.evaluate(() => { currentUser = { id: 'admin-fixture' }; currentRole = 'admin'; selectLocation(reports[0].id); });
        assert(await page.locator('#deleteSelectedReport').isVisible());
        await close();
        const feedbackContract = await page.evaluate(async () => {
            selectLocation(reports[0].id);
            const originalClient = supabaseClient, originalLoad = loadCloudReports;
            const calls = [];
            let rejectInsert = false;
            try {
                supabaseClient = { from: table => ({ insert: async payload => {
                    calls.push({ table, payload });
                    return { error: rejectInsert ? new Error('Synthetic provider failure') : null };
                } }) };
                loadCloudReports = async () => {};
                currentUser = null;
                await voteOnReport(reports[0].id, 'high');
                const voteAuth = document.getElementById('reportDetailsStatus').textContent;
                await submitCommunityNote(reports[0].id, 'Signed-out attempt');
                const blocked = calls.length;
                const noteAuth = document.getElementById('reportDetailsStatus').textContent;
                currentUser = { id: 'feedback-member' };
                await submitCommunityNote(reports[0].id, '');
                await submitCommunityNote(reports[0].id, 'x'.repeat(281));
                const invalid = calls.length;
                reports[0].dbId = 42;
                await submitCommunityNote(reports[0].id, '  Cloud-contract feedback  ');
                const success = document.getElementById('reportDetailsStatus').textContent;
                rejectInsert = true;
                const input = document.querySelector('[name="communityNote"]');
                input.value = 'Retain this draft on failure';
                await submitCommunityNote(reports[0].id, input.value);
                return { calls, blocked, invalid, voteAuth, noteAuth, success,
                    failure: document.getElementById('reportDetailsStatus').textContent, draft: input.value };
            } finally { supabaseClient = originalClient; loadCloudReports = originalLoad; }
        });
        assert.equal(feedbackContract.blocked, 0);
        assert.equal(feedbackContract.invalid, 0);
        assert.match(feedbackContract.voteAuth, /Sign in to vote/);
        assert.match(feedbackContract.noteAuth, /Sign in to submit community feedback/);
        assert.deepEqual(feedbackContract.calls[0], { table: 'feedback', payload: { report_id: 42, user_id: 'feedback-member', message: 'Cloud-contract feedback' } });
        assert.equal(feedbackContract.calls.length, 2);
        assert.equal(feedbackContract.success, 'Your community feedback was saved.');
        assert.equal(feedbackContract.failure, 'Could not save your feedback. Please try again.');
        assert.equal(feedbackContract.draft, 'Retain this draft on failure');
        console.log('PASS signed-out vote/feedback guards and stubbed feedback payload, input validation, failure/draft handling');
        await page.evaluate(() => {
            currentUser = null; currentRole = 'member'; reports[0].cloudReport = false;
            selectLocation(reports[0].id);
        });
        await page.locator('#deleteSelectedReport').click();
        assert(await page.locator('#deleteReportDialog').isVisible());
        await page.keyboard.press('Escape');
        assert(await dialog.isVisible(), 'Cancel confirmation preserves parent dialog');
        assert.equal(await page.evaluate(() => reportPendingDeletionId), null);
        await page.locator('#deleteSelectedReport').click();
        await page.locator('#confirmDeleteReport').click();
        await page.waitForFunction(() => reports.length === 0 && !document.getElementById('reportDetailsDialog').open && !document.getElementById('deleteReportDialog').open);
        assert.equal(await page.evaluate(() => Object.keys(reportMarkers).length), 0);
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), 'hidden');
        console.log('PASS owner/member/admin action visibility, reporter privacy, nested confirmation cancel/delete, marker cleanup and scroll restoration');
        assert.deepEqual(errors, [], 'No JavaScript page errors');
        console.log(`PASS report details ${baseURL}${process.env.CLEANMAP_TEST_CANDIDATE === '1' ? ' (local resource overrides; not deployment verification)' : ''}`);
    } finally {
        await context.close();
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
