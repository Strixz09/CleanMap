
const locations = []; 

const $ = id => document.getElementById(id);
const toast = $('toast');

const CLEANMAP_SUPABASE_URL = 'https://zezcbpmmhpwzlbuafsby.supabase.co';
const CLEANMAP_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_qtnXRsSr5sCXhN92hAjlcg_EzZudocb';
let supabaseClient = null;
let currentUser = null;
let currentRole = 'member';
let cleanMapCloudLoading = false;
let cleanMapAccountMode = 'signin';
let cleanMapAuthBusy = false;

let selectedLocation = null;
let reportDetailsReturnFocus = null;
let cleanMapInstance = null;
// Main Cebu Island coastline (not Cebu province): OpenStreetMap relation 3604190.
// Verified from Nominatim's polygon bounds on 2026-10-20; see docs/map-overview.md.
const CEBU_ISLAND_BOUNDS = [[9.4128637, 123.2963877], [11.2857272, 124.0702215]];
let cleanMapOverviewPending = true;
let cleanMapOverviewActive = true;
let cleanMapLayoutUpdating = false;
let cleanMapLayoutFrame = null;
let cleanMapLastSize = null;
let leafletMarkers = {};
let reportMarkers = {};
let reportLocationCoords = null;
let selectedPhotoData = '';
let selectedVideoFile = null;
let selectedVideoObjectUrl = '';
const VOTE_MINIMUM = 3;
const VOTE_AGREEMENT = 0.60;
const VOTE_LEVELS = ['low', 'moderate', 'high', 'severe'];
let locationPickerMap = null;
let locationPickerMarker = null;
let locationPickerAccuracyCircle = null;
let pendingPickedCoordinates = null;

const mapCoordinates = {
    1: [10.3157, 123.8854],
    2: [10.3237, 123.9220],
    3: [10.3103, 123.9494],
    4: [10.2447, 123.8494],
    5: [10.2500, 123.9500]
};

let reports = readStore('cleanmapReports', []);
let favorites = readStore('cleanmapFavorites', []);

function readStore(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return Array.isArray(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

function saveStore() {
    try {
        localStorage.setItem('cleanmapReports', JSON.stringify(reports));
        localStorage.setItem('cleanmapFavorites', JSON.stringify(favorites));
    } catch (error) {
        console.error('Could not save CleanMap data:', error);
        showToast('Could not save data in this browser.');
    }
}

function showToast(message) {
    if (!toast) return;

    const detailsStatus = $('reportDetailsDialog')?.open && $('reportDetailsStatus');
    if (detailsStatus) detailsStatus.textContent = message;
    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2600);
}

function renderMarkers() {
    document.querySelectorAll('.map-marker').forEach(marker => {
        marker.addEventListener('click', () => {
            selectLocation(Number(marker.dataset.location));
        });
    });
}

function canDeleteReport(report) { return !report?.cloudReport || (Boolean(currentUser) && (report.reporterId === currentUser.id || currentRole === 'admin')); }

function selectLocation(id) {
    const dialog = $('reportDetailsDialog');
    const refreshing = dialog?.open && String(selectedLocation?.id) === String(id);
    const focused = refreshing ? document.activeElement : null;
    const focusId = focused?.id;
    const focusVote = focused?.dataset.voteSeverity;
    const scrollTop = refreshing ? $('detailsCard')?.querySelector('.report-details-scroll')?.scrollTop || 0 : 0;
    const feedbackOpen = refreshing && $('detailsCard')?.querySelector('.community-feedback')?.open;
    const noteDraft = refreshing ? $('detailsCard')?.querySelector('[name="communityNote"]')?.value : '';
    const sampleLocation = locations.find(item => item.id === id);
    const submittedReport = reports.find(item => item.id === id);
    selectedLocation = sampleLocation || (submittedReport ? {
        ...submittedReport,
        name: submittedReport.location,
        level: capitalize(safeSeverity(submittedReport.severity)),
        updated: submittedReport.date,
        isSubmittedReport: true
    } : null);
    if (!selectedLocation) return;
    cleanMapOverviewPending = false;
    cleanMapOverviewActive = false;

    const coords = selectedLocation.isSubmittedReport && Number.isFinite(selectedLocation.lat) && Number.isFinite(selectedLocation.lng)
        ? [selectedLocation.lat, selectedLocation.lng]
        : mapCoordinates[id];
    if (!refreshing && cleanMapInstance && coords) cleanMapInstance.panTo(coords);

    document.querySelectorAll('.map-marker').forEach(marker => {
        marker.classList.toggle(
            'selected',
            Number(marker.dataset.location) === id
        );
    });

    const l = selectedLocation;
    const saved = favorites.includes(l.id);
    const detailsCard = $('detailsCard');

    if (!detailsCard) return;

    releaseDetailsMedia();
    detailsCard.innerHTML = `
        <header class="report-details-header">
            <div class="report-details-heading">
                <p class="report-details-eyebrow">Report details <span aria-hidden="true">/</span> ${escapeHTML(l.type || 'Pollution report')}</p>
                <h2 class="detail-location" id="reportDetailsTitle" title="${escapeHTML(l.name)}">${escapeHTML(l.name)}</h2>
                <div class="report-details-badges">
                    <span class="detail-level level-${safeSeverity(l.severity)}">${escapeHTML(l.level)} severity</span>
                    ${l.isSubmittedReport ? `<span class="report-status">${escapeHTML(l.verificationStatus || 'Pending verification')}</span>` : ''}
                </div>
                <p class="report-details-status" id="reportDetailsStatus" role="status" aria-live="polite"></p>
            </div>
            <button type="button" class="report-details-close" id="closeDetails" aria-label="Close report details" autofocus>×</button>
        </header>
        <div class="report-details-scroll" id="reportDetailsScroll" tabindex="0" role="region" aria-label="Report information and community actions">
            <div class="report-details-layout">
                <aside class="report-details-community" aria-label="Community and report actions">
                    ${l.isSubmittedReport ? buildVotePanel(l) : ''}
                    ${l.isSubmittedReport ? `<section class="report-verification"><h3>Admin verification</h3><p>${escapeHTML(l.verificationStatus || 'Pending verification')}</p><small>Admin verification is separate from community severity voting.</small></section>` : ''}
                    <section class="report-actions-section" aria-labelledby="reportActionsTitle">
                        <h3 id="reportActionsTitle">Report actions</h3>
                        <div class="detail-actions">
                            ${l.isSubmittedReport ? `${canDeleteReport(l) ? '<button class="danger-button detail-delete-button" id="deleteSelectedReport" type="button">Delete report</button>' : ''}` : '<button type="button" class="save-btn" id="favoriteButton">' + (saved ? '★ Remove favorite' : '♡ Save location') + '</button>'}
                            <button type="button" id="closeDetailsAction">Back to map</button>
                        </div>
                    </section>
                </aside>
                <section class="report-details-information" aria-labelledby="reportInformationTitle">
                    ${l.photo || l.videoUrl || l.videoKey ? `<div class="report-details-media">
                        ${l.photo ? `<div class="submitted-report-photo"><img src="${escapeHTML(l.photo)}" alt="Photo attached to this pollution report"></div>` : ''}
                        ${l.videoUrl ? `<div class="submitted-report-video"><video controls playsinline preload="metadata" src="${escapeHTML(l.videoUrl)}" aria-label="Video attached to this pollution report"></video></div>` : l.videoKey ? `<div class="submitted-report-video" data-video-key="${escapeHTML(l.videoKey)}"><p class="field-hint">Loading submitted video…</p></div>` : ''}
                    </div>` : ''}
                    <section class="report-information-section">
                        <h3 id="reportInformationTitle">Report information</h3>
                        <p class="report-description">${escapeHTML(l.description || 'No description provided.')}</p>
                        <dl class="report-metadata">
                            <div><dt>Location</dt><dd>${escapeHTML(l.name)}</dd></div>
                            ${coords ? `<div><dt>Coordinates</dt><dd>${coords.map(value => Number(value).toFixed(5)).join(', ')}</dd></div>` : ''}
                            <div><dt>${l.isSubmittedReport ? 'Date reported' : 'Last updated'}</dt><dd>${escapeHTML(l.updated || 'Date not recorded')}</dd></div>
                            ${l.reporterId && currentUser?.id === l.reporterId ? '<div><dt>Reported by</dt><dd>You</dd></div>' : ''}
                            <div><dt>Severity</dt><dd>${escapeHTML(l.level)} · ${escapeHTML(CLEANMAP_GUIDES.severities[safeSeverity(l.severity)].summary)}</dd></div>
                        </dl>
                    </section>
                </section>
            </div>
        </div>
    `;

    if (l.videoKey) hydrateVideo(detailsCard.querySelector('[data-video-key]'));
    if (l.isSubmittedReport) attachVoteHandlers(detailsCard);
    $('closeDetails').addEventListener('click', clearDetails);
    $('closeDetailsAction').addEventListener('click', clearDetails);
    if ($('favoriteButton')) $('favoriteButton').addEventListener('click', toggleFavorite);
    if ($('deleteSelectedReport')) $('deleteSelectedReport').addEventListener('click', () => requestDeleteReport(l.id));
    if (dialog && !dialog.open) {
        reportDetailsReturnFocus = document.activeElement;
        dialog.showModal();
    }
    if (refreshing) {
        const feedback = detailsCard.querySelector('.community-feedback');
        if (feedback) feedback.open = Boolean(feedbackOpen);
        const noteInput = detailsCard.querySelector('[name="communityNote"]');
        if (noteInput) noteInput.value = noteDraft || '';
        detailsCard.querySelector('.report-details-scroll').scrollTop = scrollTop;
        const nextFocus = focusId ? $(focusId) : [...detailsCard.querySelectorAll('[data-vote-severity]')].find(button => button.dataset.voteSeverity === focusVote);
        nextFocus?.focus({ preventScroll: true });
    }
}

function releaseDetailsMedia() {
    $('detailsCard')?.querySelectorAll('video').forEach(video => {
        video.pause();
        if (video.dataset.localObjectUrl) URL.revokeObjectURL(video.dataset.localObjectUrl);
    });
}

function clearDetails() {
    const dialog = $('reportDetailsDialog');
    if (dialog?.open) dialog.close();
    selectedLocation = null;
    document.querySelectorAll('.map-marker').forEach(marker => marker.classList.remove('selected'));
    releaseDetailsMedia();
    $('detailsCard')?.replaceChildren();
}

$('reportDetailsDialog')?.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || document.querySelector('#deleteReportDialog[open]')) return;
    const dialog = event.currentTarget;
    const controls = [...dialog.querySelectorAll('button, input, textarea, select, summary, video[controls], [tabindex]')]
        .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
    }
});

$('reportDetailsDialog')?.addEventListener('close', () => {
    // Escape closes the native dialog; keep selection and media state in sync.
    if ($('reportDetailsDialog').open) return;
    if (selectedLocation) clearDetails();
    if (!document.querySelector('dialog[open]')) {
        const opener = reportDetailsReturnFocus?.isConnected && reportDetailsReturnFocus.getClientRects().length
            ? reportDetailsReturnFocus : $('realMap');
        opener?.focus({ preventScroll: true });
    }
    reportDetailsReturnFocus = null;
});

function toggleFavorite() {
    if (!selectedLocation) return;

    const id = selectedLocation.id;

    if (favorites.includes(id)) {
        favorites = favorites.filter(x => x !== id);
        showToast('Location removed from favorites.');
    } else {
        favorites.push(id);
        showToast('Location saved to favorites.');
    }

    saveStore();
    selectLocation(id);
    updateProfile();
}

let mapSearchRequest = 0;
async function searchLocation() {
    const input = $('searchInput');
    if (!input) return;

    const query = input.value.trim().toLowerCase();

    const requestId = ++mapSearchRequest;
    if (!query) {
        showToast('Enter a location to search.');
        return;
    }

    const found = locations.find(location =>
        location.name.toLowerCase().includes(query) ||
        location.name.toLowerCase().replace(' city', '').includes(query)
    );

    if (!found) {
        const submittedReport = reports.find(report => String(report.location).toLowerCase().includes(query));
        if (submittedReport) {
            switchPage('map');
            selectLocation(submittedReport.id);
            return;
        }
        showToast('Searching for that place…');
        try {
            const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_KEY}&limit=1&country=ph&proximity=123.6833,10.3493`);
            if (!response.ok) throw new Error('Location search is unavailable. Please try again.');
            const data = await response.json();
            if (requestId !== mapSearchRequest || input.value.trim().toLowerCase() !== query) return;
            const place = data.features?.[0];
            if (!place?.center || !place.center.every(Number.isFinite)) {
                showToast('No matching place found. Try a more specific location.');
                return;
            }
            switchPage('map');
            if (cleanMapInstance) cleanMapInstance.setView([place.center[1], place.center[0]], 14);
            showToast(place.place_name || place.text || 'Location found.');
        } catch (error) {
            console.warn('CleanMap location search failed:', error);
            if (requestId === mapSearchRequest && input.value.trim().toLowerCase() === query) {
                showToast('Location search is unavailable. Please try again.');
            }
        }
        return;
    }

    switchPage('map');

    if (cleanMapInstance && mapCoordinates[found.id]) {
        cleanMapInstance.setView(mapCoordinates[found.id], 14);
    }

    selectLocation(found.id);
    showToast(`${found.name} selected on the map.`);
}

if ($('searchButton')) {
    $('searchButton').addEventListener('click', searchLocation);
}

if ($('searchInput')) {
    $('searchInput').addEventListener('keydown', event => {
        if (event.key === 'Enter') searchLocation();
    });
}

// Current location
if ($('locationButton')) {
    $('locationButton').addEventListener('click', () => {
        if (!navigator.geolocation) {
            showToast('Location is not supported in this browser.');
            return;
        }

        showToast('Requesting location permission…');

        navigator.geolocation.getCurrentPosition(
            position => {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;

                if (cleanMapInstance) {
                    cleanMapInstance.setView([lat, lon], 14);

                    if (window.userLocationMarker) {
                        window.userLocationMarker.remove();
                    }

                    window.userLocationMarker = L.circleMarker(
                        [lat, lon],
                        {
                            radius: 7,
                            color: '#ffffff',
                            weight: 3,
                            fillColor: '#32d6a0',
                            fillOpacity: 1
                        }
                    )
                    .addTo(cleanMapInstance)
                    .bindPopup(`Your current location · accuracy about ${Math.round(position.coords.accuracy)} m`);
                }

                const accuracy = Math.round(position.coords.accuracy || 0);
                showToast(accuracy > 100 ? `Location found, but accuracy is about ${accuracy} m.` : `Showing your location (about ${accuracy} m accuracy).`);
            },
            error => {
                showToast(
                    error.code === 1
                        ? 'Location permission was denied.'
                        : 'Could not get your location. Check browser permissions.'
                );
            },
            {
                enableHighAccuracy: true,
                maximumAge: 0,
                timeout: 20000
            }
        );
    });
}

// Zoom controls
if ($('zoomIn')) {
    $('zoomIn').addEventListener('click', () => {
        if (cleanMapInstance) cleanMapInstance.zoomIn();
    });
}

if ($('zoomOut')) {
    $('zoomOut').addEventListener('click', () => {
        if (cleanMapInstance) cleanMapInstance.zoomOut();
    });
}

// Fit only once the map has real dimensions. A hidden welcome screen/tab has none.
// Keep fitting on dimension changes until a user or location action changes the view.
function scheduleMapLayout() {
    cancelAnimationFrame(cleanMapLayoutFrame);
    cleanMapLayoutFrame = requestAnimationFrame(() => {
        const host = $('realMap');
        if (!host || !host.clientWidth || !host.clientHeight) return;
        if (!cleanMapInstance) {
            initRealMap();
            return;
        }
        const size = [host.clientWidth, host.clientHeight];
        const changed = !cleanMapLastSize || size.some((value, i) => value !== cleanMapLastSize[i]);
        cleanMapLayoutUpdating = true;
        try {
            cleanMapInstance.invalidateSize({ animate: false, pan: true, debounceMoveend: true });
            if (cleanMapOverviewPending || (cleanMapOverviewActive && changed)) {
                cleanMapInstance.fitBounds(CEBU_ISLAND_BOUNDS, {
                    padding: [Math.min(32, Math.round(size[0] * 0.05)), 24],
                    animate: false
                });
                cleanMapOverviewPending = false;
            }
            cleanMapLastSize = size;
        } finally {
            cleanMapLayoutUpdating = false;
        }
    });
}

// Initialize the real interactive map
function initRealMap() {
    const host = $('realMap');
    if (!host || !host.clientWidth || !host.clientHeight) return;

    if (!window.L) {
        host.innerHTML = `
            <div class="map-error">
                The map library did not load.
                Check your internet connection and refresh.
            </div>
        `;
        return;
    }

    if (cleanMapInstance) {
        scheduleMapLayout();
        return;
    }

    cleanMapInstance = L.map(host, {
        zoomControl: false,
        scrollWheelZoom: true,
        zoomSnap: 0.25
    });
    cleanMapLayoutUpdating = true;
    try {
        cleanMapInstance.fitBounds(CEBU_ISLAND_BOUNDS, {
            padding: [Math.min(32, Math.round(host.clientWidth * 0.05)), 24],
            animate: false
        });
    } finally {
        cleanMapLayoutUpdating = false;
    }
    cleanMapInstance.on('movestart zoomstart', () => {
        if (!cleanMapLayoutUpdating) {
            cleanMapOverviewPending = false;
            cleanMapOverviewActive = false;
        }
    });

    // MAPTILER TILE LAYER
    // Uses your MapTiler API key.
    L.tileLayer(
        'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=f4Hu0XFv1usz76Jq4S5X',
        {
            tileSize: 512,
            zoomOffset: -1,
            maxZoom: 20,
            attribution:
                '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' +
                '&copy; OpenStreetMap contributors'
        }
    ).addTo(cleanMapInstance);

    // Pollution markers
    locations.forEach(location => {
        const coords = mapCoordinates[location.id] || [10.3157, 123.8854];

        const marker = L.circleMarker(coords, {
            radius: 9,
            color: '#ffffff',
            weight: 2,
            fillColor: severityColor(location.severity),
            fillOpacity: 1
        }).addTo(cleanMapInstance);

        marker.bindTooltip(location.name, {
            direction: 'top',
            offset: [0, -8]
        });

        marker.on('click', () => selectLocation(location.id));
        leafletMarkers[location.id] = marker;
    });
    renderReportMarkers();

    scheduleMapLayout();
}

// Navigation
function switchPage(page) {
    if (page === 'admin' && (!currentUser || currentRole !== 'admin')) {
        showToast('Administrator access is required.');
        page = 'map';
    }
    document.querySelectorAll('.page').forEach(element => {
        element.classList.toggle('active', element.id === `page-${page}`);
    });

    document.querySelectorAll('.nav-item').forEach(button => {
        button.classList.toggle('active', button.dataset.page === page);
    });

    if (page === 'profile') updateProfile();
    if (page === 'statistics') updateStatistics();
    if (page === 'admin') loadAdminDashboard();

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (page === 'map') scheduleMapLayout();
}

document.querySelectorAll('.nav-item').forEach(button => {
    button.addEventListener('click', () => switchPage(button.dataset.page));
});

// Map legend
if ($('toggleLegend')) {
    $('toggleLegend').addEventListener('click', () => {
        const content = $('legendContent');
        if (!content) return;

        const hidden = content.hidden;
        content.hidden = !hidden;
        $('toggleLegend').textContent = hidden ? '×' : '+';
    });
}

// Notifications and settings
if ($('notificationButton')) {
    $('notificationButton').addEventListener('click', () => {
        showInfo(
            'Notifications',
            'CleanMap displays community-submitted reports. No sample pollution reports are preloaded.'
        );
    });
}

if ($('settingsButton')) {
    $('settingsButton').addEventListener('click', () => {
        showInfo(
            'Settings',
            'This prototype stores submitted reports and favorite locations in your current browser using local storage.'
        );
    });
}

if ($('dialogClose')) {
    $('dialogClose').addEventListener('click', () => {
        if ($('infoDialog')) $('infoDialog').close();
    });
}

if ($('dialogOkay')) {
    $('dialogOkay').addEventListener('click', () => {
        if ($('infoDialog')) $('infoDialog').close();
    });
}

function showInfo(title, message) {
    if (!$('infoDialog')) return;

    $('dialogTitle').textContent = title;
    $('dialogText').textContent = message;
    $('infoDialog').showModal();
}

// Add compact styling for the report enhancements while keeping the existing theme.
(function addReportEnhancementStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .photo-preview-wrap{margin-top:10px;padding:10px;border:1px solid var(--line,#213952);border-radius:14px;background:var(--surface,#0c1d32)}
      .photo-preview-wrap[hidden],.location-suggestions[hidden]{display:none}
      #photoPreview{display:block;width:100%;max-height:230px;object-fit:contain;border-radius:9px;background:#06101d}
      .remove-photo-button{margin-top:8px;border:0;border-radius:8px;padding:8px 12px;background:#24384f;color:#fff;cursor:pointer}
      .report-location-wrap{position:relative;display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
      .report-location-wrap #reportLocation{flex:1;min-width:180px}
      .location-autofill-button{border:1px solid var(--line,#213952);border-radius:10px;padding:0 12px;background:var(--surface2,#10253d);color:var(--text,#eef5ff);cursor:pointer}
      .location-suggestions{position:absolute;z-index:1200;top:calc(100% + 5px);left:0;right:0;max-height:220px;overflow:auto;border:1px solid var(--line,#213952);border-radius:12px;background:var(--surface,#0c1d32);box-shadow:0 10px 28px #0007}
      .location-suggestion{display:block;width:100%;padding:11px 13px;text-align:left;border:0;border-bottom:1px solid var(--line,#213952);background:transparent;color:var(--text,#eef5ff);cursor:pointer}
      .location-suggestion:hover,.location-suggestion:focus{background:var(--surface2,#10253d)}
      .field-hint{display:block;color:var(--muted,#8fa5bc);font-size:.8rem;margin-top:6px;margin-bottom:12px}
      .submitted-report-photo img{width:100%;max-height:220px;object-fit:contain;border-radius:10px;margin-top:12px}
      .submitted-report-tag{font-size:.8rem;color:var(--muted,#8fa5bc)}
      .location-picker-dialog{width:min(920px,calc(100vw - 24px));max-width:none;max-height:92vh;overflow:auto;padding:24px;border:1px solid var(--line,#213952);border-radius:18px;background:var(--surface,#0c1d32);color:var(--text,#eef5ff)}
      .location-picker-dialog::backdrop{background:rgba(1,8,18,.78);backdrop-filter:blur(3px)}
      .location-picker-dialog h2{margin:0 36px 8px 0}.location-picker-dialog>p{color:var(--muted,#8fa5bc);font-size:.9rem}
      #locationPickerMap{width:100%;height:min(55vh,480px);min-height:300px;border-radius:12px;overflow:hidden;background:#081426}
      .picker-coordinates{margin:10px 0!important;font-size:.82rem!important}
      .location-picker-actions{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .location-picker-actions .primary-button{width:auto;margin:0;padding:12px 18px}
      .report-location-wrap{gap:8px}
      @media(max-width:520px){.location-picker-dialog{padding:16px}#locationPickerMap{height:48vh;min-height:260px}.location-picker-actions>*{flex:1}}
    `;
    document.head.appendChild(style);
})();

// Video blobs are stored in IndexedDB so they do not consume localStorage's small quota.
const VIDEO_DB_NAME = 'cleanmap-media';
const VIDEO_STORE_NAME = 'videos';
function openVideoDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('This browser does not support local video storage.'));
        const request = indexedDB.open(VIDEO_DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(VIDEO_STORE_NAME)) request.result.createObjectStore(VIDEO_STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open video storage.'));
    });
}
async function saveVideoBlob(key, blob) {
    const db = await openVideoDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE_NAME, 'readwrite');
        tx.objectStore(VIDEO_STORE_NAME).put(blob, String(key));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { const err = tx.error; db.close(); reject(err || new Error('Could not save video.')); };
    });
}
async function getVideoBlob(key) {
    const db = await openVideoDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE_NAME, 'readonly');
        const request = tx.objectStore(VIDEO_STORE_NAME).get(String(key));
        request.onsuccess = () => { const value = request.result || null; db.close(); resolve(value); };
        request.onerror = () => { const err = request.error; db.close(); reject(err || new Error('Could not load video.')); };
    });
}
async function deleteVideoBlob(key) {
    if (!key || !('indexedDB' in window)) return;
    try {
        const db = await openVideoDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(VIDEO_STORE_NAME, 'readwrite');
            tx.objectStore(VIDEO_STORE_NAME).delete(String(key));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (error) { console.warn('Could not remove saved video:', error); }
}
async function hydrateVideo(container) {
    if (!container || !container.dataset.videoKey) return;
    try {
        const blob = await getVideoBlob(container.dataset.videoKey);
        if (!blob || !container.isConnected) return;
        const url = URL.createObjectURL(blob);
        const video = document.createElement('video');
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = url;
        video.dataset.localObjectUrl = url;
        video.setAttribute('aria-label', 'Community-submitted noise pollution video');
        container.replaceChildren(video);
    } catch (error) {
        container.textContent = 'Video could not be loaded in this browser.';
    }
}
function renderVoteSummary(report) {
    const votes = Object.fromEntries(VOTE_LEVELS.map(level => [level, Number(report.votes?.[level] || 0)]));
    const total = VOTE_LEVELS.reduce((sum, level) => sum + votes[level], 0);
    const top = VOTE_LEVELS.slice().sort((a, b) => votes[b] - votes[a])[0];
    const agreement = total ? votes[top] / total : 0;
    const verified = total >= VOTE_MINIMUM && agreement >= VOTE_AGREEMENT;
    return { votes, total, top, agreement, verified };
}

function refreshReportSeverity(report) {
    const result = renderVoteSummary(report);

    report.communitySeverity = result.verified ? result.top : '';
    report.severity = result.verified
        ? result.top
        : safeSeverity(report.reporterSeverity || report.severity);

    report.communityVoteStatus = result.verified
        ? 'Community-supported'
        : 'Pending community votes';
}

async function voteOnReport(reportId, severity) {
    const report = reports.find(item => String(item.id) === String(reportId));
    if (!report || !VOTE_LEVELS.includes(severity)) return;
    if (supabaseClient && !currentUser) { showToast('Sign in to vote on community reports.'); return; }
    if (supabaseClient && report.cloudReport !== false) {
        try {
            const { data: existing, error: readError } = await supabaseClient.from('report_votes')
                .select('id,severity').eq('report_id', report.dbId ?? report.id).eq('user_id', currentUser.id).maybeSingle();
            if (readError) throw readError;
            let result;
            if (existing) {
                if (existing.severity === severity) { showToast(`You already voted ${capitalize(severity)} on this report.`); return; }
                result = await supabaseClient.from('report_votes').update({ severity }).eq('id', existing.id);
            } else {
                result = await supabaseClient.from('report_votes').insert({ report_id: report.dbId ?? report.id, user_id: currentUser.id, severity });
            }
            if (result.error) throw result.error;
            await loadCloudReports();
            if (selectedLocation && String(selectedLocation.id) === String(report.id)) selectLocation(report.id);
            showToast('Your vote was saved for the community.');
            return;
        } catch (error) {
            console.error('CleanMap vote failed:', error);
            showToast(error.message || 'Could not save your vote.');
            return;
        }
    }
    report.votes = report.votes || { low: 0, moderate: 0, high: 0, severe: 0 };
    const previous = report.myVote;
    if (previous === severity) { showToast(`You already voted ${capitalize(severity)} on this report.`); return; }
    if (previous && VOTE_LEVELS.includes(previous)) report.votes[previous] = Math.max(0, Number(report.votes[previous] || 0) - 1);
    report.votes[severity] = Number(report.votes[severity] || 0) + 1;
    report.myVote = severity;
    refreshReportSeverity(report); saveStore(); updateStatistics(); updateProfile(); renderReportMarkers();
    if (selectedLocation && String(selectedLocation.id) === String(report.id)) selectLocation(report.id);
    showToast('Your vote was saved in this browser.');
}

function buildVotePanel(report) {
    const result = renderVoteSummary(report);
    const labels = {
        low: 'Low',
        moderate: 'Moderate',
        high: 'High',
        severe: 'Severe'
    };

    const bars = VOTE_LEVELS.map(level => `
        <div class="vote-stat-row">
            <span>${labels[level]}</span>
            <div class="vote-track">
                <i class="${level}-bg" style="width:${
                    result.total
                        ? result.votes[level] / result.total * 100
                        : 0
                }%"></i>
            </div>
            <small>${result.votes[level]} · ${
                result.total
                    ? Math.round(result.votes[level] / result.total * 100)
                    : 0
            }%</small>
        </div>
    `).join('');

    const notes = Array.isArray(report.notes) ? report.notes : [];

    const notesMarkup = notes.length
        ? `<div class="community-notes-list">
            <strong>Community feedback</strong>
            ${notes.slice(-3).reverse().map(note => `
                <blockquote>
                    <p>${escapeHTML(note.text)}</p>
                    <small>${escapeHTML(note.date || 'Recently submitted')}</small>
                </blockquote>
            `).join('')}
        </div>`
        : '<p class="field-hint">No community notes yet. Share a reason if you think the severity should be different.</p>';

    const communityStatus = result.verified
        ? 'Community-supported'
        : 'Awaiting community agreement';

    const communityDetail = result.verified
        ? `Community-supported pollution level: ${labels[result.top]}`
        : `Needs at least ${VOTE_MINIMUM} votes and ${Math.round(VOTE_AGREEMENT * 100)}% agreement to become community-supported.`;

    return `
        <section class="community-vote-panel">
            <div class="vote-panel-heading">
                <h3>Community voting</h3>
                <span class="pill ${result.verified ? 'moderate-pill' : 'low-pill'}">
                    ${communityStatus}
                </span>
            </div>

            <p class="field-hint">
                ${result.total} community vote${result.total === 1 ? '' : 's'}.
                ${communityDetail}
            </p>

            <p class="field-label">
                What severity do you think this evidence shows?
            </p>

            <div class="vote-buttons">
                ${VOTE_LEVELS.map(level => `
                    <button
                        type="button"
                        class="vote-button ${report.myVote === level ? 'voted' : ''}"
                        data-vote-severity="${level}"
                        data-vote-report="${escapeHTML(report.id)}"
                        aria-pressed="${report.myVote === level ? 'true' : 'false'}"
                    >${labels[level]}</button>
                `).join('')}
            </div>

            <small class="field-hint">
                Sign in to submit a community vote. One vote per account per report.
            </small>

            <div class="vote-stats" role="group" aria-label="Community vote counts and percentages">${bars}</div>

            <details class="community-feedback">
                <summary>Community feedback · ${notes.length} note${notes.length === 1 ? '' : 's'}</summary>
            <form class="community-note-form"
                data-note-form
                data-note-report="${escapeHTML(report.id)}">

                <label class="field-label" for="communityNote-${escapeHTML(report.id)}">
                    Add a note or reason
                </label>

                <textarea
                    id="communityNote-${escapeHTML(report.id)}"
                    name="communityNote"
                    maxlength="280"
                    rows="2"
                    placeholder="For example, explain what in the photo/video supports your assessment..."
                ></textarea>

                <button type="submit" class="view-report-button" id="submitCommunityNote-${escapeHTML(report.id)}">
                    Submit feedback
                </button>
            </form>

            ${notesMarkup}
            </details>
        </section>
    `;
}
function attachVoteHandlers(container) {
    if (!container) return;
    container.querySelectorAll('[data-vote-severity]').forEach(button => button.addEventListener('click', () => voteOnReport(button.dataset.voteReport, button.dataset.voteSeverity)));
    container.querySelectorAll('[data-note-form]').forEach(form => form.addEventListener('submit', async event => {
        event.preventDefault();
        const input = form.elements.namedItem('communityNote');
        const button = form.querySelector('button[type="submit"]');
        if (button.disabled) return;
        const hadFocus = document.activeElement === button;
        button.disabled = true;
        try { await submitCommunityNote(form.dataset.noteReport, input?.value); }
        finally {
            button.disabled = false;
            // Disabling the submit button blurs it; the refresh may replace it too.
            if (hadFocus && document.activeElement === document.body && $('reportDetailsDialog')?.open) {
                $(button.id)?.focus({ preventScroll: true });
            }
        }
    }));
}

async function submitCommunityNote(reportId, value) {
    const report = reports.find(item => String(item.id) === String(reportId));
    const text = String(value || '').trim();
    if (!report) return;
    if (!text || text.length > 280) { showToast('Write a note of 1–280 characters before submitting.'); return; }
    if (supabaseClient && !currentUser) { showToast('Sign in to submit community feedback.'); return; }
    try {
        if (supabaseClient && report.cloudReport !== false) {
            const { error } = await supabaseClient.from('feedback').insert({
                report_id: report.dbId ?? report.id, user_id: currentUser.id, message: text
            });
            if (error) throw error;
            await loadCloudReports();
        } else {
            report.notes = [...(report.notes || []), { text, date: new Date().toLocaleString() }];
            saveStore();
        }
        if (selectedLocation && String(selectedLocation.id) === String(report.id)) {
            const input = $('detailsCard')?.querySelector('[name="communityNote"]');
            if (input) input.value = '';
            selectLocation(report.id);
        }
        showToast('Your community feedback was saved.');
    } catch (error) {
        console.warn('CleanMap community feedback failed:', error);
        showToast('Could not save your feedback. Please try again.');
    }
}

// Compress the photo before saving it in localStorage.
function compressPhoto(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read that photo.'));
        reader.onload = () => {
            const image = new Image();
            image.onerror = () => reject(new Error('Please choose a valid image file.'));
            image.onload = () => {
                const maxSide = 1000;
                const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.72));
            };
            image.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

// Photo preview
if ($('reportPhoto')) {
    $('reportPhoto').addEventListener('change', async () => {
        const file = $('reportPhoto').files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('Please choose an image file.');
            $('reportPhoto').value = '';
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            showToast('Choose an image smaller than 8 MB.');
            $('reportPhoto').value = '';
            return;
        }
        try {
            selectedPhotoData = await compressPhoto(file);
            $('photoLabel').textContent = file.name;
            $('photoPreview').src = selectedPhotoData;
            $('photoPreviewWrap').hidden = false;
        } catch (error) {
            showToast(error.message || 'Could not preview that photo.');
        }
    });
}
if ($('removePhotoButton')) {
    $('removePhotoButton').addEventListener('click', () => {
        selectedPhotoData = '';
        $('reportPhoto').value = '';
        $('photoLabel').textContent = 'Add photo';
        $('photoPreview').removeAttribute('src');
        $('photoPreviewWrap').hidden = true;
    });
}

// Noise reports can include video/audio evidence; other report types use photo evidence.
if ($('reportType')) $('reportType').addEventListener('change', () => {
    const isNoise = $('reportType').value === 'Noise Pollution';
    if ($('noiseVideoField')) $('noiseVideoField').hidden = !isNoise;
    if ($('photoHelpText')) $('photoHelpText').textContent = isNoise ? 'Optional supporting photo; use the video field below for noise evidence' : 'For visible pollution such as waste or dirty water';
    if (isNoise && $('reportVideo')) $('reportVideo').setAttribute('aria-describedby', 'videoPreviewWrap');
});
if ($('reportVideo')) $('reportVideo').addEventListener('change', () => {
    const file = $('reportVideo').files[0];
    if (!file) return;
    if (!file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
        showToast('Choose a video or audio file for noise evidence.'); $('reportVideo').value = ''; return;
    }
    if (file.size > 15 * 1024 * 1024) {
        showToast('Choose a video/audio file smaller than 15 MB.'); $('reportVideo').value = ''; return;
    }
    selectedVideoFile = file;
    if (selectedVideoObjectUrl) URL.revokeObjectURL(selectedVideoObjectUrl);
    selectedVideoObjectUrl = URL.createObjectURL(file);
    $('videoLabel').textContent = file.name;
    $('videoPreview').src = selectedVideoObjectUrl;
    $('videoPreviewWrap').hidden = false;
});
if ($('removeVideoButton')) $('removeVideoButton').addEventListener('click', () => {
    selectedVideoFile = null;
    $('reportVideo').value = '';
    $('videoLabel').textContent = 'Add video with audio';
    $('videoPreview').removeAttribute('src');
    $('videoPreviewWrap').hidden = true;
    if (selectedVideoObjectUrl) URL.revokeObjectURL(selectedVideoObjectUrl);
    selectedVideoObjectUrl = '';
});

// MapTiler geocoding powers report location suggestions.
const MAPTILER_KEY = 'f4Hu0XFv1usz76Jq4S5X';
let locationSearchTimer = null;
let latestLocationSearch = 0;

function hideLocationSuggestions() {
    const list = $('locationSuggestions');
    if (list) {
        list.hidden = true;
        list.innerHTML = '';
    }
}
function chooseReportLocation(feature) {
    const center = feature.center || feature.geometry?.coordinates;
    if (!center || center.length < 2) return;
    reportLocationCoords = { lat: Number(center[1]), lng: Number(center[0]) };
    $('reportLocation').value = feature.place_name || feature.text || '';
    const hint = $('locationAccuracyHint');
    if (hint) hint.textContent = 'This is the center of the selected place. For an exact spot, tap “Choose on map” and adjust the pin.';
    hideLocationSuggestions();
}
if ($('reportLocation')) {
    $('reportLocation').addEventListener('input', () => {
        reportLocationCoords = null;
        const hint = $('locationAccuracyHint');
        if (hint) hint.textContent = 'Choose one of the suggestions, use GPS, or choose the exact spot on the map.';
        const query = $('reportLocation').value.trim();
        clearTimeout(locationSearchTimer);
        if (query.length < 3) {
            hideLocationSuggestions();
            return;
        }
        locationSearchTimer = setTimeout(async () => {
            const requestId = ++latestLocationSearch;
            try {
                const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_KEY}&limit=5&country=ph&proximity=123.8854,10.3157`;
                const response = await fetch(url);
                if (!response.ok) throw new Error('Location search unavailable');
                const data = await response.json();
                if (requestId !== latestLocationSearch) return;
                const list = $('locationSuggestions');
                list.innerHTML = '';
                (data.features || []).forEach(feature => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'location-suggestion';
                    button.setAttribute('role', 'option');
                    button.textContent = feature.place_name || feature.text;
                    button.addEventListener('click', () => chooseReportLocation(feature));
                    list.appendChild(button);
                });
                list.hidden = !list.children.length;
            } catch {
                hideLocationSuggestions();
            }
        }, 300);
    });
    $('reportLocation').addEventListener('blur', () => setTimeout(hideLocationSuggestions, 180));
}
// Exact location picker: the user can move a fixed map pin like a ride-hailing app.
function setPickerCoordinates(lat, lng, accuracy = null) {
    pendingPickedCoordinates = { lat: Number(lat), lng: Number(lng) };
    if (!locationPickerMap) return;
    const point = [pendingPickedCoordinates.lat, pendingPickedCoordinates.lng];
    if (!locationPickerMarker) {
        locationPickerMarker = L.marker(point, { draggable: true }).addTo(locationPickerMap);
        locationPickerMarker.on('dragend', () => {
            const p = locationPickerMarker.getLatLng();
            setPickerCoordinates(p.lat, p.lng);
        });
    } else {
        locationPickerMarker.setLatLng(point);
    }
    if (locationPickerAccuracyCircle) {
        locationPickerAccuracyCircle.remove();
        locationPickerAccuracyCircle = null;
    }
    if (Number.isFinite(accuracy) && accuracy > 0) {
        locationPickerAccuracyCircle = L.circle(point, {
            radius: accuracy, color: '#2998ff', weight: 1,
            fillColor: '#2998ff', fillOpacity: 0.12
        }).addTo(locationPickerMap);
    }
    const hint = $('pickerCoordinates');
    if (hint) hint.textContent = `Pin: ${pendingPickedCoordinates.lat.toFixed(6)}, ${pendingPickedCoordinates.lng.toFixed(6)}` +
        (Number.isFinite(accuracy) && accuracy > 0 ? ` · GPS accuracy about ${Math.round(accuracy)} m` : ' · Adjust the pin if needed');
}

function openLocationPicker(coords = null, accuracy = null) {
    const dialog = $('locationPickerDialog');
    if (!dialog || !window.L) {
        showToast('The map picker could not load. Check your internet connection.');
        return;
    }
    const start = coords || (reportLocationCoords ? [reportLocationCoords.lat, reportLocationCoords.lng] : [10.3157, 123.8854]);
    if (!dialog.open) dialog.showModal();
    if (!locationPickerMap) {
        locationPickerMap = L.map('locationPickerMap', { zoomControl: true }).setView(start, coords ? 18 : 15);
        L.tileLayer('https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=' + MAPTILER_KEY, {
            tileSize: 512, zoomOffset: -1, maxZoom: 20,
            attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; OpenStreetMap contributors'
        }).addTo(locationPickerMap);
        locationPickerMap.on('click', event => {
            setPickerCoordinates(event.latlng.lat, event.latlng.lng);
            locationPickerMap.panTo(event.latlng);
        });
    }
    locationPickerMap.setView(start, coords ? 18 : 16);
    setPickerCoordinates(start[0], start[1], accuracy);
    setTimeout(() => locationPickerMap && locationPickerMap.invalidateSize(), 120);
}

async function reverseGeocode(lat, lng) {
    try {
        const url = `https://api.maptiler.com/geocoding/${lng},${lat}.json?key=${MAPTILER_KEY}&limit=1&language=en`;
        const response = await fetch(url);
        const data = response.ok ? await response.json() : null;
        return data?.features?.[0]?.place_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    } catch {
        return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }
}

if ($('chooseMapLocationButton')) {
    $('chooseMapLocationButton').addEventListener('click', () => {
        const coords = reportLocationCoords ? [reportLocationCoords.lat, reportLocationCoords.lng] : null;
        openLocationPicker(coords);
    });
}
if ($('locationPickerClose')) $('locationPickerClose').addEventListener('click', () => $('locationPickerDialog').close());
if ($('confirmPickedLocation')) {
    $('confirmPickedLocation').addEventListener('click', async () => {
        if (!pendingPickedCoordinates) {
            showToast('Tap the map to choose a location first.');
            return;
        }
        reportLocationCoords = { ...pendingPickedCoordinates };
        $('reportLocation').value = await reverseGeocode(reportLocationCoords.lat, reportLocationCoords.lng);
        const hint = $('locationAccuracyHint');
        if (hint) hint.textContent = `Exact pin selected: ${reportLocationCoords.lat.toFixed(5)}, ${reportLocationCoords.lng.toFixed(5)}. You can still adjust it on the map.`;
        hideLocationSuggestions();
        $('locationPickerDialog').close();
        showToast('Exact report location selected.');
    });
}

function requestReportGps() {
    if (!navigator.geolocation) {
        showToast('Location is not supported in this browser.');
        return;
    }
    showToast('Getting a fresh GPS location…');
    navigator.geolocation.getCurrentPosition(position => {
        const { latitude: lat, longitude: lng, accuracy } = position.coords;
        reportLocationCoords = { lat, lng };
        openLocationPicker([lat, lng], accuracy);
        const hint = $('locationAccuracyHint');
        if (hint) hint.textContent = accuracy > 100
            ? `GPS accuracy is about ${Math.round(accuracy)} m. Move the map pin to the exact spot before confirming.`
            : `GPS accuracy is about ${Math.round(accuracy)} m. Check the pin and adjust it if needed.`;
        showToast(accuracy > 100 ? `GPS is approximate (${Math.round(accuracy)} m). Adjust the pin.` : `GPS found (about ${Math.round(accuracy)} m accuracy). Check the pin.`);
    }, error => {
        showToast(error.code === 1 ? 'Location permission was denied. Allow location access in your browser.' : error.code === 3 ? 'GPS took too long. Try again outdoors or choose the location on the map.' : 'Could not get GPS. Check device location settings or choose the location on the map.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 });
}
if ($('reportGpsButton')) $('reportGpsButton').addEventListener('click', requestReportGps);
if ($('pickerUseGps')) $('pickerUseGps').addEventListener('click', requestReportGps);

// Place submitted reports on the real Leaflet map.
function addReportMarker(report) {
    if (!cleanMapInstance || !Number.isFinite(report.lat) || !Number.isFinite(report.lng)) return;
    if (reportMarkers[report.id]) reportMarkers[report.id].remove();
    const marker = L.circleMarker([report.lat, report.lng], {
        radius: 10, color: '#ffffff', weight: 2,
        fillColor: severityColor(report.severity), fillOpacity: 1
    }).addTo(cleanMapInstance);
    marker.bindTooltip(report.location, { direction: 'top', offset: [0, -8] });
    marker.on('click', () => selectLocation(report.id));
    reportMarkers[report.id] = marker;
}
function renderReportMarkers() {
    Object.keys(reportMarkers).forEach(id => {
        if (!reports.some(report => String(report.id) === String(id))) {
            reportMarkers[id]?.remove();
            delete reportMarkers[id];
        }
    });
    reports.forEach(addReportMarker);
}

let reportPendingDeletionId = null;
function requestDeleteReport(id) {
    const report = reports.find(item => String(item.id) === String(id));
    if (!report) {
        showToast('This report could not be found.');
        return;
    }
    reportPendingDeletionId = report.id;
    const dialog = $('deleteReportDialog');
    const text = $('deleteReportText');
    
if (text) {
    text.textContent = report.cloudReport
        ? `Delete the ${report.type} report for ${report.location} from shared CleanMap? This removes the shared report for all users. This action cannot be undone.`
        : `Delete the ${report.type} report for ${report.location} from this browser? This action cannot be undone.`;
}

    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    else if (window.confirm(`Delete the ${report.type} report for ${report.location}? This cannot be undone.`)) deleteReport(report.id);
}

function closeDeleteReportDialog() {
    const dialog = $('deleteReportDialog');
    if (dialog?.open) dialog.close();
    reportPendingDeletionId = null;
}

async function deleteReport(id) {
    const report = reports.find(item => String(item.id) === String(id));
    if (!report) { closeDeleteReportDialog(); showToast('This report could not be found.'); return; }
    if (supabaseClient && report.cloudReport !== false) {
        if (!currentUser) { closeDeleteReportDialog(); showToast('Sign in to delete reports.'); return; }
        if (report.reporterId !== currentUser.id && currentRole !== 'admin') { closeDeleteReportDialog(); showToast('Only the report owner or an admin can delete this report.'); return; }
        try {
            const { error } = await supabaseClient.from('reports').delete().eq('id', report.dbId ?? report.id);
            if (error) throw error;
            const paths = [report.photoPath, report.videoPath].filter(Boolean);
            if (paths.length) {
                const { error: mediaError } = await supabaseClient.storage.from('cleanmap-media').remove(paths);
                if (mediaError) console.warn('CleanMap: report deleted but media cleanup failed:', mediaError);
            }
            reports = reports.filter(item => String(item.id) !== String(id));
            if (reportMarkers[report.id]) { reportMarkers[report.id].remove(); delete reportMarkers[report.id]; }
            favorites = favorites.filter(favoriteId => String(favoriteId) !== String(report.id));
            saveStore(); if (selectedLocation && String(selectedLocation.id) === String(report.id)) clearDetails();
            closeDeleteReportDialog(); updateStatistics(); updateProfile();
            showToast('Report deleted from CleanMap.');
            return;
        } catch (error) {
            console.error('CleanMap cloud delete failed:', error);
            closeDeleteReportDialog(); showToast(error.message || 'Could not delete the report.'); return;
        }
    }
    reports = reports.filter(item => String(item.id) !== String(id));
    if (report.videoKey) deleteVideoBlob(report.videoKey);
    if (reportMarkers[report.id]) { reportMarkers[report.id].remove(); delete reportMarkers[report.id]; }
    favorites = favorites.filter(favoriteId => String(favoriteId) !== String(report.id)); saveStore();
    if (selectedLocation && String(selectedLocation.id) === String(report.id)) clearDetails();
    closeDeleteReportDialog(); updateStatistics(); updateProfile();
    showToast('Report deleted. The map and statistics have been updated.');
}

if ($('confirmDeleteReport')) $('confirmDeleteReport').addEventListener('click', () => {
    if (reportPendingDeletionId !== null) deleteReport(reportPendingDeletionId);
});
if ($('cancelDeleteReport')) $('cancelDeleteReport').addEventListener('click', closeDeleteReportDialog);
if ($('deleteReportClose')) $('deleteReportClose').addEventListener('click', closeDeleteReportDialog);
if ($('deleteReportDialog')) $('deleteReportDialog').addEventListener('cancel', () => { reportPendingDeletionId = null; });

// Submit a pollution report
if ($('reportForm')) {
    $('reportForm').addEventListener('submit', async event => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        let coords = reportLocationCoords;
        const locationText = String(form.get('location') || '').trim();
        if (!coords) { showToast('Choose a location suggestion, use GPS, or tap “Choose on map” before submitting.'); return; }
        if (supabaseClient && !currentUser) { showToast('Please sign in before submitting a shared report.'); return; }
        const submitButton = formElement.querySelector('[type="submit"]');
        if (submitButton) submitButton.disabled = true;
        let photo = selectedPhotoData;
        if (!photo && $('reportPhoto')?.files?.[0]) {
            try { photo = await compressPhoto($('reportPhoto').files[0]); }
            catch { photo = ''; }
        }
        const reportType = String(form.get('type') || '');
        const initialSeverity = String(form.get('severity') || 'moderate');
        const description = String(form.get('description') || '').trim();
        const now = new Date();
        let report;
        try {
            if (supabaseClient && currentUser) {
                const token = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
                const mediaPaths = [];
                let photoPath = null, videoPath = null;
                if (photo) {
                    const blob = await (await fetch(photo)).blob();
                    photoPath = `${currentUser.id}/${token()}.jpg`;
                    const { error } = await supabaseClient.storage.from('cleanmap-media').upload(photoPath, blob, { contentType: 'image/jpeg', upsert: false });
                    if (error) throw error;
                    mediaPaths.push(photoPath);
                }
                if (selectedVideoFile && reportType === 'Noise Pollution') {
                    const ext = (selectedVideoFile.name.split('.').pop() || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
                    videoPath = `${currentUser.id}/${token()}.${ext}`;
                    const { error } = await supabaseClient.storage.from('cleanmap-media').upload(videoPath, selectedVideoFile, { contentType: selectedVideoFile.type || 'video/mp4', upsert: false });
                    if (error) throw error;
                    mediaPaths.push(videoPath);
                }
                const { data, error } = await supabaseClient.from('reports').insert({
                    reporter_id: currentUser.id, location: locationText, pollution_type: reportType,
                    severity: initialSeverity, description, latitude: coords.lat, longitude: coords.lng,
                    photo_url: photoPath, video_url: videoPath, verification_status: 'Pending verification'
                }).select().single();
                if (error) {
                    if (mediaPaths.length) await supabaseClient.storage.from('cleanmap-media').remove(mediaPaths);
                    throw error;
                }
                report = mapCloudReport(data, [], [], currentUser.id);
                await loadCloudReports();
                report = reports.find(item => String(item.dbId) === String(data.id)) || report;
            } else {
                const reportId = Date.now();
                report = { id: reportId, location: locationText, type: reportType, severity: initialSeverity,
                    reporterSeverity: initialSeverity, description, date: now.toLocaleString(), lat: coords?.lat, lng: coords?.lng,
                    photo: photo || '', videoKey: selectedVideoFile && reportType === 'Noise Pollution' ? `cleanmap-video-${reportId}` : '',
                    votes: { low: 0, moderate: 0, high: 0, severe: 0 }, notes: [], myVote: '', verificationStatus: 'Pending verification', cloudReport: false };
                if (report.videoKey) await saveVideoBlob(report.videoKey, selectedVideoFile);
                reports.unshift(report); saveStore();
            }
        } catch (error) {
            console.error('CleanMap report submission failed:', error);
            showToast(error?.message || 'Report could not be submitted. Please try again.');
            if (submitButton) submitButton.disabled = false;
            return;
        }
        formElement.reset(); selectedPhotoData = ''; selectedVideoFile = null;
        if (selectedVideoObjectUrl) URL.revokeObjectURL(selectedVideoObjectUrl);
        selectedVideoObjectUrl = '';
        if ($('reportVideo')) $('reportVideo').value = '';
        if ($('videoLabel')) $('videoLabel').textContent = 'Add video with audio';
        if ($('videoPreview')) $('videoPreview').removeAttribute('src');
        if ($('videoPreviewWrap')) $('videoPreviewWrap').hidden = true;
        if ($('noiseVideoField')) $('noiseVideoField').hidden = $('reportType')?.value !== 'Noise Pollution';
        reportLocationCoords = null;
        if ($('photoLabel')) $('photoLabel').textContent = 'Add photo';
        if ($('photoPreview')) $('photoPreview').removeAttribute('src');
        if ($('photoPreviewWrap')) $('photoPreviewWrap').hidden = true;
        hideLocationSuggestions();
        updateStatistics(); updateProfile(); renderReportMarkers();
        if (cleanMapInstance && Number.isFinite(report.lat) && Number.isFinite(report.lng)) {
            addReportMarker(report); switchPage('map'); cleanMapInstance.setView([report.lat, report.lng], 15); selectLocation(report.id);
            showToast('Report submitted and pinned on the map.');
        } else { showToast('Report submitted.'); switchPage('statistics'); }
        if (submitButton) submitButton.disabled = false;
    });
}

// Statistics: show only real reports; the empty state starts at zero.
function updateStatistics() {
    const counts = { low: 0, moderate: 0, high: 0, severe: 0 };
    reports.forEach(report => { counts[safeSeverity(report.severity)] += 1; });
    const total = reports.length;
    const uniqueLocations = [...new Set(reports
        .map(r => String(r.location || '').trim())
        .filter(Boolean))];

    if ($('totalReports')) $('totalReports').textContent = total;
    if ($('chartTotal')) $('chartTotal').textContent = total;
    if ($('chartLow')) $('chartLow').textContent = counts.low;
    if ($('chartModerate')) $('chartModerate').textContent = counts.moderate;
    if ($('chartHigh')) $('chartHigh').textContent = counts.high;
    if ($('chartSevere')) $('chartSevere').textContent = counts.severe;

    const donut = document.querySelector('.donut-chart');
    if (donut) {
        if (total === 0) {
            donut.style.background = 'conic-gradient(var(--border, #263449) 0 100%)';
        } else {
            const lowEnd = counts.low / total * 100;
            const moderateEnd = (counts.low + counts.moderate) / total * 100;
            const highEnd = (counts.low + counts.moderate + counts.high) / total * 100;
            donut.style.background = `conic-gradient(var(--low) 0 ${lowEnd}%, var(--moderate) ${lowEnd}% ${moderateEnd}%, var(--high) ${moderateEnd}% ${highEnd}%, var(--severe) ${highEnd}% 100%)`;
        }
    }

    if ($('affectedAreas')) $('affectedAreas').textContent = uniqueLocations.length;

    const areaBars = document.querySelector('.area-bars');
    if (areaBars) {
        if (!total) {
            areaBars.innerHTML = '<p class="muted">No affected areas reported yet.</p>';
        } else {
            const countsByArea = new Map();
            reports.forEach(report => {
                const name = String(report.location || '').trim();
                if (name) countsByArea.set(name, (countsByArea.get(name) || 0) + 1);
            });
            areaBars.innerHTML = [...countsByArea.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, count]) => {
                    const percent = Math.round(count / total * 100);
                    return `<div><span>${escapeHTML(name)}</span><div class="bar-track"><i style="width:${percent}%"></i></div><b>${percent}%</b></div>`;
                }).join('');
        }
    }

    const list = $('activityList');
    if (!list) return;
    const recent = reports.slice(0, 4).map(report => `
        <div>
            <i class="${safeSeverity(report.severity)}-bg"></i>
            <span><b>${escapeHTML(report.type)}</b><small>${escapeHTML(report.location)} · ${escapeHTML(report.date)}</small></span>
            <em class="pill ${safeSeverity(report.severity)}-pill">${capitalize(safeSeverity(report.severity))}</em>
        </div>
    `).join('');
    list.innerHTML = recent || '<p class="muted">No reports submitted yet.</p>';
}

// Profile and favorites
function updateProfile() {
    if ($('favoriteCount')) $('favoriteCount').textContent = favorites.length;
    const myReports = currentUser
    ? reports.filter(report =>
        report.cloudReport
            ? String(report.reporterId) === String(currentUser.id)
            : false
    )
    : reports.filter(report => !report.cloudReport);

if ($('myReportCount')) {
    $('myReportCount').textContent = myReports.length;
}

    const reportList = $('myReportsList');
    if (reportList) {
        if (!myReports.length) {
            reportList.innerHTML = '<p class="muted">You have not submitted any reports yet. Use Submit to add your first report.</p>';
        } else {
            reportList.innerHTML = myReports.map(report => `
                <article class="my-report-item">
                    ${report.photo ? `<img class="my-report-photo" src="${report.photo}" alt="Photo for report at ${escapeHTML(report.location)}">` : report.videoKey ? '<div class="my-report-photo photo-placeholder" aria-label="Video evidence attached">▶</div>' : '<div class="my-report-photo photo-placeholder" aria-label="No report photo">⌖</div>'}
                    <div class="my-report-content">
                        <div class="my-report-heading"><b>${escapeHTML(report.type)}</b><span class="pill ${safeSeverity(report.severity)}-pill">${capitalize(safeSeverity(report.severity))}</span></div>
                        <p>${escapeHTML(report.location)}</p>
                        <small>${escapeHTML(report.date || 'Date not recorded')}</small>
                        <p class="my-report-description">${escapeHTML(report.description || '')}</p>
                        ${report.videoUrl ? `<div class="submitted-report-video"><video controls preload="metadata" src="${escapeHTML(report.videoUrl)}"></video></div>` : report.videoKey ? `<div class="submitted-report-video" data-video-key="${escapeHTML(report.videoKey)}"><p class="field-hint">Loading submitted video…</p></div>` : ''}
                        
<p class="field-hint">
    ${renderVoteSummary(report).total} community vote(s) ·
    ${renderVoteSummary(report).verified
        ? 'Community-supported'
        : 'Pending community votes'}
</p>
<p class="field-hint">
    Admin status: ${escapeHTML(report.verificationStatus || 'Pending verification')}
</p>

                        <div class="my-report-actions"><button type="button" class="view-report-button" data-view-report="${escapeHTML(report.id)}">View on map</button>${canDeleteReport(report) ? `<button type="button" class="danger-button" data-delete-report="${escapeHTML(report.id)}">Delete</button>` : ''}</div>
                    </div>
                </article>
            `).join('');
            reportList.querySelectorAll('[data-video-key]').forEach(hydrateVideo);
            reportList.querySelectorAll('[data-delete-report]').forEach(button => button.addEventListener('click', () => requestDeleteReport(button.dataset.deleteReport)));
            reportList.querySelectorAll('[data-view-report]').forEach(button => button.addEventListener('click', () => {
                const report = myReports.find(
    item => String(item.id) === String(button.dataset.viewReport)
);
                if (!report) return;
                switchPage('map');
                if (cleanMapInstance && Number.isFinite(report.lat) && Number.isFinite(report.lng)) cleanMapInstance.setView([report.lat, report.lng], 16);
                selectLocation(report.id);
            }));
        }
    }

    const list = $('favoritesList');
    if (!list) return;

    const valid = favorites
        .map(id => locations.find(location => location.id === id))
        .filter(Boolean);

    if (!valid.length) {
        list.innerHTML = '<p class="muted">No saved locations yet. Save one from the map.</p>';
        return;
    }

    list.innerHTML = valid.map(location => `
        <div class="favorite-location">
            <span>⌖</span>
            <div>
                <b>${escapeHTML(location.name)}</b>
                <small>${escapeHTML(location.level)} pollution · ${escapeHTML(location.type)}</small>
            </div>
            <button data-remove="${location.id}">Remove</button>
        </div>
    `).join('');

    list.querySelectorAll('[data-remove]').forEach(button => {
        button.addEventListener('click', () => {
            favorites = favorites.filter(id => id !== Number(button.dataset.remove));
            saveStore();
            updateProfile();

            if (selectedLocation) selectLocation(selectedLocation.id);
            showToast('Favorite removed.');
        });
    });
}

// Profile actions
document.querySelectorAll('[data-profile-action]').forEach(button => {
    button.addEventListener('click', () => {
        const action = button.dataset.profileAction;

        if (action === 'favorites' || action === 'reports') {
            const panel = action === 'favorites' ? document.querySelector('.favorites-panel') : $('myReportsPanel');
            if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
           if (action === 'reports') {
    updateProfile();
} {
    showToast('You have not submitted any reports yet.');
}
            return;
        }

        const messages = {
            reports: `You have submitted ${myReports.length} report(s) in your account.`,
            notifications: 'There are no live notifications in this prototype.',
            settings: 'Reports and favorites are saved only in this browser. Clearing browser data may remove them.',
            help: 'CleanMap displays community-submitted reports. Map pins and statistics are empty until real reports are submitted; community reports are not a substitute for official environmental measurements.'
        };

        const titles = {
            reports: 'Reports',
            notifications: 'Notifications',
            settings: 'Settings',
            help: 'Help & Support'
        };

        showInfo(
            titles[action] || capitalize(action),
            messages[action] || 'This feature is part of the prototype.'
        );
    });
});

// Utility functions
function severityColor(value) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--${safeSeverity(value)}`).trim();
}

function safeSeverity(value) {
    return ['low', 'moderate', 'high', 'severe'].includes(value)
        ? value
        : 'moderate';
}

function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[character]));
}

// Start CleanMap
renderMarkers();
if (window.ResizeObserver && $('realMap')) {
    const mapSizeObserver = new ResizeObserver(scheduleMapLayout);
    mapSizeObserver.observe($('realMap'));
}
window.addEventListener('resize', scheduleMapLayout);
initRealMap();
updateStatistics();
updateProfile();


/* =========================================
   CleanMap Supabase authentication (Stage 1)
   Existing map/report features remain local for now.
========================================= */


function initializeCleanMapWelcome() {
    const welcome = $('welcomeScreen');
    const app = $('appShell');
    const getStarted = $('welcomeGetStarted');
    const signIn = $('welcomeSignIn');
    const dialog = $('accountDialog');
    const modeSwitch = $('accountModeSwitch');

    // The welcome screen is optional for older HTML versions.
    if (!welcome || !app) {
        if (app) app.hidden = false;
        return;
    }

    const showWelcome = () => {
        welcome.hidden = false;
        app.hidden = true;
    };

    const showApp = () => {
        welcome.hidden = true;
        app.hidden = false;

        scheduleMapLayout();
    };

const welcomeSeen = localStorage.getItem('cleanmapWelcomeSeen');

if (welcomeSeen === 'true') {
    showApp();
} else {
    showWelcome();
}


    getStarted?.addEventListener('click', async () => {
        let sessionUser = currentUser;

        try {
            if (supabaseClient) {
                const { data, error } =
                    await supabaseClient.auth.getSession();

                if (error) throw error;

                sessionUser = data?.session?.user || null;
                currentUser = sessionUser;
            }
        } catch (error) {
            console.warn(
                '[CleanMap] Could not check the current session:',
                error
            );
        }

        localStorage.setItem('cleanmapWelcomeSeen', 'true');
        showApp();

        if (sessionUser) {
            if (dialog?.open) dialog.close();
            return;
        }

        if (dialog && !dialog.open) {
            if (modeSwitch && cleanMapAccountMode !== 'signup') {
                modeSwitch.click();
            }

            dialog.showModal();
        } else if (!dialog) {
            showToast(
                'Please use the Sign in button to access your CleanMap account.'
            );
        }
    });

    signIn?.addEventListener('click', () => {
        showApp();

        if (cleanMapAccountMode !== 'signin' && modeSwitch) {
            modeSwitch.click();
        } else {
            cleanMapAccountMode = 'signin';
        }

        if (dialog && !dialog.open) {
            dialog.showModal();
        }
    });
}


function initializeCleanMapSupabase() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        console.error('CleanMap: Supabase JavaScript library did not load.');
        return;
    }
    try {
        supabaseClient = window.supabase.createClient(
            CLEANMAP_SUPABASE_URL,
            CLEANMAP_SUPABASE_PUBLISHABLE_KEY
        );
    } catch (error) {
        console.error('CleanMap: Supabase client initialization failed:', error);
        supabaseClient = null;
    }
}

function cloudObjectPath(value) {
    if (!value) return null;
    // Legacy public URLs are not treated as private bucket object paths.
    return String(value).startsWith('http') ? null : String(value);
}

async function signedMediaUrl(path) {
    if (!path || !supabaseClient) return '';
    if (String(path).startsWith('http')) return path;
    const { data, error } = await supabaseClient.storage.from('cleanmap-media').createSignedUrl(path, 3600);
    if (error) { console.warn('CleanMap media URL unavailable:', error.message); return ''; }
    return data?.signedUrl || '';
}

function mapCloudReport(row, voteRows = [], feedbackRows = [], userId = currentUser?.id) {
    const votes = { low: 0, moderate: 0, high: 0, severe: 0 };
    let myVote = '';
    voteRows.filter(v => String(v.report_id) === String(row.id)).forEach(v => {
        if (VOTE_LEVELS.includes(v.severity)) votes[v.severity]++;
        if (String(v.user_id) === String(userId)) myVote = v.severity;
    });
    const report = {
        id: `cloud-${row.id}`, dbId: row.id, location: row.location, type: row.pollution_type,
        severity: safeSeverity(row.severity), reporterSeverity: safeSeverity(row.severity),
        description: row.description || '', date: row.created_at ? new Date(row.created_at).toLocaleString() : '',
        lat: row.latitude == null ? NaN : Number(row.latitude), lng: row.longitude == null ? NaN : Number(row.longitude),
        photoPath: cloudObjectPath(row.photo_url), videoPath: cloudObjectPath(row.video_url), photo: String(row.photo_url || '').startsWith('http') ? row.photo_url : '', videoUrl: String(row.video_url || '').startsWith('http') ? row.video_url : '',
        votes, myVote, notes: feedbackRows.filter(f => String(f.report_id) === String(row.id)).map(f => ({ text: f.message, date: new Date(f.created_at).toLocaleString() })),
        verificationStatus: row.verification_status || 'Pending verification', reporterId: row.reporter_id, cloudReport: true
    };
    return report;
}

async function loadCloudReports() {
    if (!supabaseClient || !currentUser || cleanMapCloudLoading) return;
    cleanMapCloudLoading = true;
    try {
        const [reportResult, voteResult, feedbackResult] = await Promise.all([
            supabaseClient.from('reports').select('*').order('created_at', { ascending: false }),
            supabaseClient.from('report_votes').select('id,report_id,user_id,severity'),
            supabaseClient.from('feedback').select('id,report_id,user_id,message,created_at').not('report_id', 'is', null).order('created_at', { ascending: true })
        ]);
        if (reportResult.error) throw reportResult.error;
        if (voteResult.error) throw voteResult.error;
        if (feedbackResult.error) throw feedbackResult.error;
        const voteRows = voteResult.data || [], feedbackRows = feedbackResult.data || [];
        const cloudReports = await Promise.all((reportResult.data || []).map(async row => {
            const report = mapCloudReport(row, voteRows, feedbackRows, currentUser.id);
            const [photoUrl, videoUrl] = await Promise.all([signedMediaUrl(report.photoPath), signedMediaUrl(report.videoPath)]);
            report.photo = photoUrl; report.videoUrl = videoUrl;
            const voteSummary = renderVoteSummary(report);
            if (voteSummary.verified) report.severity = voteSummary.top;
            return report;
        }));
        const savedLocalReports = readStore('cleanmapReports', []).filter(r => r.cloudReport !== true);
        reports = [...cloudReports, ...savedLocalReports];
        saveStore();
        renderReportMarkers(); updateStatistics(); updateProfile();
        if (currentRole === 'admin' && $('page-admin')?.classList.contains('active')) loadAdminDashboard();
        if (selectedLocation?.isSubmittedReport) {
            const refreshed = reports.find(r => String(r.id) === String(selectedLocation.id));
            if (refreshed) selectLocation(refreshed.id); else clearDetails();
        }
    } catch (error) {
        console.error('CleanMap could not load shared reports:', error);
        showToast(error?.message || 'Could not load shared reports from Supabase.');
    } finally { cleanMapCloudLoading = false; }
}

async function refreshCleanMapRole() {
    currentRole = 'member';
    if (!supabaseClient || !currentUser) return;
    const { data, error } = await supabaseClient.from('profiles').select('role').eq('id', currentUser.id).maybeSingle();
    if (error) console.warn('CleanMap role lookup failed:', error.message);
    if (!error && data?.role === 'admin') currentRole = 'admin';
    updateAdminAccess();
}

function updateAdminAccess() {
    const allowed = Boolean(currentUser && currentRole === 'admin');
    const nav = $('adminNavButton');
    const page = $('page-admin');
    const badge = $('adminRoleBadge');
    if (nav) nav.hidden = !allowed;
    if (page) page.hidden = !allowed;
    if (badge) badge.hidden = !allowed;
    if (!allowed && page?.classList.contains('active')) switchPage('map');
    if (allowed && page?.classList.contains('active')) loadAdminDashboard();
}

function renderAdminDashboard(reportRows, feedbackRows, feedbackTotal = feedbackRows.length) {
    const total = reportRows.length;
    const pending = reportRows.filter(report => {
        const status = String(report.verificationStatus || 'Pending verification').toLowerCase();
        return status === 'pending verification' || status === 'pending';
    }).length;
    if ($('adminTotalReports')) $('adminTotalReports').textContent = String(total);
    if ($('adminPendingReports')) $('adminPendingReports').textContent = String(pending);
    if ($('adminFeedbackCount')) $('adminFeedbackCount').textContent = String(feedbackTotal);

    const reportList = $('adminReportsList');
    if (reportList) {
        if (!reportRows.length) {
            reportList.innerHTML = '<p class="admin-empty-state">No cloud reports found.</p>';
        } else {
            const statuses = ['Pending verification', 'Verified', 'Rejected'];
            reportList.innerHTML = reportRows.map(report => {
                const currentStatus = statuses.includes(report.verificationStatus) ? report.verificationStatus : 'Pending verification';
                const evidence = report.photo
                    ? `<a class="admin-evidence-link" href="${escapeHTML(report.photo)}" target="_blank" rel="noopener noreferrer">Open photo evidence</a>`
                    : '';
                const video = report.videoUrl
                    ? `<a class="admin-evidence-link" href="${escapeHTML(report.videoUrl)}" target="_blank" rel="noopener noreferrer">Open video/audio evidence</a>`
                    : '';
                return `<article class="admin-report-card" data-admin-report-card="${escapeHTML(report.id)}">
                    <h3>${escapeHTML(report.type || 'Pollution report')} · ${escapeHTML(report.location || 'Unknown location')}</h3>
                    <div class="admin-report-meta"><span>Severity: ${escapeHTML(capitalize(safeSeverity(report.severity)))}</span><span>Submitted: ${escapeHTML(report.date || 'Unknown date')}</span></div>
                    <p>${escapeHTML(report.description || 'No description provided.')}</p>
                    <div class="admin-report-meta"><span class="admin-status-label">Status: ${escapeHTML(currentStatus)}</span></div>
                    ${evidence}${video}
                    <div class="admin-status-row"><label for="admin-status-${escapeHTML(report.id)}">Verification status</label><select class="admin-status-select" id="admin-status-${escapeHTML(report.id)}" data-admin-status-for="${escapeHTML(report.id)}">${statuses.map(status => `<option value="${status}" ${status === currentStatus ? 'selected' : ''}>${status}</option>`).join('')}</select><button type="button" class="admin-action-button" data-admin-save-status="${escapeHTML(report.id)}">Save status</button><button type="button" class="admin-action-button admin-delete-button" data-admin-delete-report="${escapeHTML(report.id)}">Delete report</button></div>
                </article>`;
            }).join('');
            reportList.querySelectorAll('[data-admin-save-status]').forEach(button => {
                button.addEventListener('click', () => updateAdminReportStatus(button.dataset.adminSaveStatus, button));
            });
            reportList.querySelectorAll('[data-admin-delete-report]').forEach(button => {
                button.addEventListener('click', () => requestDeleteReport(button.dataset.adminDeleteReport));
            });
        }
    }

    const feedbackList = $('adminFeedbackList');
    if (feedbackList) {
        if (!feedbackRows.length) {
            feedbackList.innerHTML = '<p class="admin-empty-state">No community feedback has been submitted yet.</p>';
        } else {
            feedbackList.innerHTML = feedbackRows.map(item => {
                const related = item.report_id == null ? 'General feedback' : `Report #${escapeHTML(item.report_id)}`;
                const date = item.created_at ? new Date(item.created_at).toLocaleString() : 'Date unavailable';
                return `<article class="admin-feedback-card"><div class="admin-feedback-meta"><span>${related}</span><span>${escapeHTML(date)}</span></div><p>${escapeHTML(item.message || '')}</p></article>`;
            }).join('');
        }
    }
}

async function loadAdminDashboard() {
    if (!currentUser || currentRole !== 'admin' || !supabaseClient) return;
    const reportList = $('adminReportsList');
    const feedbackList = $('adminFeedbackList');
    if (reportList && !reports.some(report => report.cloudReport)) reportList.innerHTML = '<p class="muted">Loading reports…</p>';
    if (feedbackList) feedbackList.innerHTML = '<p class="muted">Loading feedback…</p>';
    try {
        const [reportResult, feedbackResult, feedbackCountResult] = await Promise.all([
            supabaseClient.from('reports').select('*', { count: 'exact' }).order('created_at', { ascending: false }),
            supabaseClient.from('feedback').select('id,report_id,user_id,message,created_at').order('created_at', { ascending: false }).limit(100),
            supabaseClient.from('feedback').select('id', { count: 'exact', head: true })
        ]);
        if (reportResult.error) throw reportResult.error;
        if (feedbackResult.error) throw feedbackResult.error;
        const cloudRows = reportResult.data || [];
        const voteResult = await supabaseClient.from('report_votes').select('id,report_id,user_id,severity');
        if (voteResult.error) throw voteResult.error;
        const voteRows = voteResult.data || [];
        const feedbackRows = feedbackResult.data || [];
        const dashboardReports = await Promise.all(cloudRows.map(async row => {
            const report = mapCloudReport(row, voteRows, feedbackRows, currentUser.id);
            const [photoUrl, videoUrl] = await Promise.all([signedMediaUrl(report.photoPath), signedMediaUrl(report.videoPath)]);
            report.photo = photoUrl;
            report.videoUrl = videoUrl;
            return report;
        }));
        renderAdminDashboard(dashboardReports, feedbackRows, feedbackCountResult.count ?? feedbackRows.length);
    } catch (error) {
        console.error('CleanMap admin dashboard load failed:', error);
        if (reportList) reportList.innerHTML = `<p class="admin-empty-state">Could not load reports: ${escapeHTML(error.message || 'Unknown error')}</p>`;
        if (feedbackList) feedbackList.innerHTML = `<p class="admin-empty-state">Could not load feedback: ${escapeHTML(error.message || 'Unknown error')}</p>`;
        showToast('Could not load admin data. Check Supabase permissions.');
    }
}



async function updateAdminReportStatus(reportId, button) {
    if (!currentUser || currentRole !== 'admin' || !supabaseClient) {
        showToast('Administrator access is required.');
        return;
    }

    const allowedStatuses = [
        'Pending verification',
        'Verified',
        'Rejected'
    ];

    const select = document.querySelector(
        `[data-admin-status-for="${CSS.escape(String(reportId))}"]`
    );

    const nextStatus = select?.value;

    if (!allowedStatuses.includes(nextStatus)) {
        showToast('Choose a valid verification status.');
        return;
    }

    // Resolve the database ID, even if the report list is stale.
    const report = reports.find(
        item => String(item.id) === String(reportId)
    );

    const dbId = report?.dbId ??
        (String(reportId).startsWith('cloud-')
            ? String(reportId).slice('cloud-'.length)
            : null);

    if (!dbId) {
        showToast('Could not identify the shared report. Refresh and try again.');
        return;
    }

    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = 'Saving…';

    try {
        const { data, error } = await supabaseClient
            .from('reports')
            .update({ verification_status: nextStatus })
            .eq('id', dbId)
            .select('id, verification_status')
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            throw new Error(
                'No report was updated. Check admin permissions and the report ID.'
            );
        }

        await loadCloudReports();
        await loadAdminDashboard();

        showToast('Report verification status updated.');
    } catch (error) {
        console.error('CleanMap status update failed:', error);
        showToast(
            error?.message ||
            'Could not update status. Check Supabase permissions.'
        );
    } finally {
        button.disabled = false;
        button.textContent = originalLabel;
    }
}

function initializeCleanMapAccountUI() {
    const dialog = $('accountDialog');
    const openButton = $('accountButton');
    const closeButton = $('accountDialogClose');
    const form = $('accountForm');
    const title = $('accountDialogTitle');
    const status = $('accountStatus');
    const nameField = $('accountDisplayNameField');
    const nameInput = $('accountDisplayName');
    const emailInput = $('accountEmail');
    const passwordInput = $('accountPassword');
    const submitButton = $('accountSubmit');
    const modeSwitch = $('accountModeSwitch');
    const signOutButton = $('accountSignOut');

    if (!dialog || !openButton || !form || !status) {
        console.error('CleanMap: account dialog elements are missing.');
        return;
    }

    const setStatus = message => { status.textContent = message; };

    function setMode(mode) {
        cleanMapAccountMode = mode;
        const creating = mode === 'signup';
        title.textContent = creating ? 'Create your CleanMap account' : 'CleanMap Account';
        nameField.hidden = !creating;
        nameInput.required = creating;
        passwordInput.autocomplete = creating ? 'new-password' : 'current-password';
        submitButton.textContent = creating ? 'Create account' : 'Sign in';
        modeSwitch.textContent = creating
            ? 'Already have an account? Sign in'
            : 'Need an account? Create one';
        modeSwitch.hidden = Boolean(currentUser);
        form.hidden = Boolean(currentUser);
        setStatus(creating
            ? 'Use an email address you can access. You may need to confirm it by email.'
            : 'Sign in to your CleanMap account.');
    }

    async function refreshCleanMapAccountUI() {
        if (!supabaseClient) {
            openButton.textContent = 'Sign in';
            setStatus('Supabase could not initialize. Check your internet connection and project configuration.');
            return;
        }
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.error('CleanMap: session check failed:', error);
            setStatus('Could not check your session. Please try again.');
            return;
        }

        const previousUserId = currentUser?.id || null;
        currentUser = data.session?.user || null;
        if (currentUser) {
            await refreshCleanMapRole();
            updateAdminAccess();
            await loadCloudReports();
            if (currentRole === 'admin') await loadAdminDashboard();
            openButton.textContent = 'Account';
            signOutButton.hidden = false;
            modeSwitch.hidden = true;
            form.hidden = true;
            nameField.hidden = true;

            const profileName = currentUser.user_metadata?.display_name || currentUser.email || 'CleanMap User';
            const profileHeading = document.querySelector('.profile-card h2');
            if (profileHeading) profileHeading.textContent = profileName;
            const profileDescription = document.querySelector('.profile-card > p');
            if (profileDescription) profileDescription.textContent = 'Community Environment Watcher';
            setStatus('Signed in as ' + (currentUser.email || profileName) + '.');
        } else {
            if (previousUserId) { reports = readStore('cleanmapReports', []).filter(r => r.cloudReport !== true); renderReportMarkers(); updateStatistics(); updateProfile(); }
            currentRole = 'member';
            updateAdminAccess();
            openButton.textContent = 'Sign in';
            signOutButton.hidden = true;
            form.hidden = false;
            setMode(cleanMapAccountMode);
            const profileHeading = document.querySelector('.profile-card h2');
            if (profileHeading) profileHeading.textContent = 'CleanMap User';
            const profileDescription = document.querySelector('.profile-card > p');
            if (profileDescription) profileDescription.textContent = 'Community Environment Watcher';
        }
    }

    openButton.addEventListener('click', async () => {
        await refreshCleanMapAccountUI();
        if (!dialog.open) dialog.showModal();
    });
    closeButton?.addEventListener('click', () => dialog.close());
    modeSwitch.addEventListener('click', () => {
        setMode(cleanMapAccountMode === 'signin' ? 'signup' : 'signin');
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (cleanMapAuthBusy) return;
        if (!supabaseClient) {
            setStatus('Supabase is unavailable. Check the connection and reload CleanMap.');
            return;
        }
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        const displayName = nameInput.value.trim();
        if (cleanMapAccountMode === 'signup' && !displayName) {
            setStatus('Please enter a display name.');
            nameInput.focus();
            return;
        }

        cleanMapAuthBusy = true;
        submitButton.disabled = true;
        setStatus(cleanMapAccountMode === 'signup' ? 'Creating your account...' : 'Signing in...');
        try {
            let result;
            if (cleanMapAccountMode === 'signup') {
                result = await supabaseClient.auth.signUp({
                    email,
                    password,
                    options: { data: { display_name: displayName } }
                });
            } else {
                result = await supabaseClient.auth.signInWithPassword({ email, password });
            }
            if (result.error) throw result.error;

            if (cleanMapAccountMode === 'signup' && !result.data.session) {
                setStatus('Account created. Check your email for a confirmation link, then sign in.');
                return;
            }
            await refreshCleanMapAccountUI();
            passwordInput.value = '';
            setStatus('You are signed in.');
            if (currentUser) dialog.close();
        } catch (error) {
            console.error('CleanMap authentication error:', error);
            setStatus(error?.message || 'Authentication failed. Please try again.');
        } finally {
            cleanMapAuthBusy = false;
            submitButton.disabled = false;
        }
    });

    signOutButton.addEventListener('click', async () => {
        if (!supabaseClient || cleanMapAuthBusy) return;
        cleanMapAuthBusy = true;
        signOutButton.disabled = true;
        try {
            const { error } = await supabaseClient.auth.signOut();
            if (error) throw error;
            currentUser = null;
            passwordInput.value = '';
            setMode('signin');
            await refreshCleanMapAccountUI();
            setStatus('You have signed out.');
        } catch (error) {
            console.error('CleanMap sign-out error:', error);
            setStatus(error?.message || 'Could not sign out. Please try again.');
        } finally {
            cleanMapAuthBusy = false;
            signOutButton.disabled = false;
        }
    });

    // Restore session and update the button when authentication changes.
    supabaseClient?.auth.onAuthStateChange((_event, session) => {
        currentUser = session?.user || null;
        // Defer UI refresh so auth event callbacks do not perform Supabase calls directly.
        Promise.resolve().then(() => refreshCleanMapAccountUI());
    });
    refreshCleanMapAccountUI();
}

initializeCleanMapSupabase();
updateAdminAccess();
initializeCleanMapAccountUI();
initializeCleanMapWelcome();
