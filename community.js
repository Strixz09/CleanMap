/* Community features use the existing Supabase client and report-details renderer.
 * Public identity is read only from the explicit public-profile projection.
 */
const PUBLIC_PROFILE_FIELDS = 'id,username,display_name,bio,avatar_url,city,barangay,created_at';
const publicProfiles = new Map();
let profileRequest = 0;
let profileEditorOwner = null;
let avatarDraft = null;
let avatarSelectionVersion = 0;
let avatarPreviewUrl = '';
let removeAvatarDraft = false;
let communityReady = false;
let communityAuthGeneration = 0;
let ownProfileRequest = 0;
const profilePages = new Map();
const COMMUNITY_PAGE_SIZE = 12;

function safePublicImage(value) {
    try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}
function avatarMarkup(profile, large = false) {
    const url = safePublicImage(profile?.avatar_url);
    return `<span class="member-avatar${large ? ' member-avatar-large' : ''}" aria-hidden="true">${url ? `<img src="${escapeHTML(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/></svg>'}</span>`;
}
function authorMarkup(userId, date, fallback = 'Community report') {
    const profile = publicProfiles.get(String(userId));
    const name = profile?.display_name || (profile?.username ? `@${profile.username}` : 'Community member');
    const when = date ? `<small>${escapeHTML(date)}</small>` : '';
    return profile
        ? `<div class="report-author"><button type="button" class="author-link" data-public-profile="${escapeHTML(profile.id)}">${avatarMarkup(profile)}<span>${escapeHTML(name)}${profile.username ? `<small>@${escapeHTML(profile.username)}</small>` : ''}</span></button>${when}</div>`
        : `<div class="report-author">${avatarMarkup(null)}<span>${escapeHTML(fallback)}${when}</span></div>`;
}
async function fetchPublicProfiles(ids) {
    const missing = [...new Set(ids.filter(Boolean).map(String))].filter(id => !publicProfiles.has(id));
    if (!supabaseClient || !missing.length) return;
    for (let offset = 0; offset < missing.length; offset += 100) {
        const { data, error } = await supabaseClient.from('cleanmap_public_profiles').select(PUBLIC_PROFILE_FIELDS).in('id', missing.slice(offset, offset + 100));
        if (error) { console.warn('CleanMap public profiles unavailable:', error); return; }
        (data || []).forEach(profile => publicProfiles.set(String(profile.id), profile));
    }
}
function profileSummary(profile, counts, owner) {
    return `<div class="member-hero">${avatarMarkup(profile, true)}<div class="member-intro"><p class="eyebrow">CLEANMAP COMMUNITY</p><h2>${escapeHTML(profile.display_name || 'Community member')}</h2>${profile.username ? `<p class="member-username">@${escapeHTML(profile.username)}</p>` : '<p class="muted">Username not set</p>'}<p class="member-bio">${escapeHTML(profile.bio || 'No biography shared.')}</p><p class="muted">${escapeHTML([profile.barangay, profile.city].filter(Boolean).join(', ') || 'Location not shared')} · Joined ${escapeHTML(profile.created_at ? new Date(profile.created_at).toLocaleDateString(undefined,{month:'long',year:'numeric'}) : 'date unavailable')}</p>${owner ? '<button type="button" class="secondary-dialog-button" data-edit-profile>Edit profile</button>' : ''}</div></div><div class="member-counts"><div><strong>${counts.reports ?? '—'}</strong><span>Reports</span></div><div><strong>${counts.feedback ?? '—'}</strong><span>Feedback contributions</span></div></div>`;
}
async function profileCounts(id) {
    if (!currentUser) return { reports: null, feedback: null };
    const [r, f] = await Promise.all([
        supabaseClient.from('reports').select('id', { count: 'exact', head: true }).eq('reporter_id', id),
        supabaseClient.from('feedback').select('id', { count: 'exact', head: true }).eq('user_id', id).not('report_id','is',null)
    ]);
    return { reports: r.error ? null : r.count, feedback: f.error ? null : f.count };
}
async function loadOwnProfile() {
    if (!communityReady || !supabaseClient || !currentUser) return;
    const id = currentUser.id, request = ++ownProfileRequest;
    const target = $('selfProfileView');
    try {
        await fetchPublicProfiles([id]);
        const counts = await profileCounts(id);
        if (request !== ownProfileRequest || currentUser?.id !== id) return;
        const profile = publicProfiles.get(id);
        target.innerHTML = profile ? profileSummary(profile, counts, true) : '<p class="muted">Your profile is not available yet. Try signing in again after profile setup is complete.</p>';
        $('myReportCount').textContent = counts.reports ?? '—';
        if (profile) await loadProfileActivity(id, 'own', true);
    } catch (error) {
        console.warn('CleanMap profile load failed:', error);
        if (currentUser?.id === id) target.textContent = 'Could not load your profile. Please try again.';
    }
}
async function openPublicProfile(id) {
    clearDetails();
    switchPage('member');
    const request = ++profileRequest;
    $('publicProfileView').innerHTML = '<p role="status">Loading community profile…</p>';
    $('memberReports').replaceChildren(); $('memberFeedback').replaceChildren();
    try {
        await fetchPublicProfiles([id]);
        const counts = await profileCounts(id);
        if (request !== profileRequest) return;
        const profile = publicProfiles.get(String(id));
        if (!profile) { $('publicProfileView').textContent = 'This public profile is unavailable.'; return; }
        $('publicProfileView').innerHTML = profileSummary(profile, counts, currentUser?.id === id);
        await loadProfileActivity(id, 'member', true);
    } catch (error) {
        console.warn('CleanMap public profile failed:', error);
        if (request === profileRequest) $('publicProfileView').textContent = 'Could not load this profile. Please try again.';
    }
}
async function loadProfileActivity(id, scope, reset = false) {
    const reportsTarget = $(scope === 'own' ? 'myReportsList' : 'memberReports');
    const notesTarget = $(scope === 'own' ? 'ownFeedback' : 'memberFeedback');
    if (!currentUser) {
        reportsTarget.textContent = 'Sign in to browse reports shared by this member.';
        notesTarget.textContent = 'Sign in to browse community feedback.';
        return;
    }
    const generation = communityAuthGeneration;
    const state = reset ? { id, reportPage: 0, feedbackPage: 0, busy: false } : profilePages.get(scope);
    if (!state || state.busy) return;
    profilePages.set(scope,state); state.busy = true;
    if (reset) { reportsTarget.textContent = 'Loading reports…'; notesTarget.textContent = 'Loading feedback…'; }
    try {
        const [r, f] = await Promise.all([
            directoryQuery().eq('reporter_id', id).order('created_at',{ascending:false}).order('id').range(state.reportPage * 12,state.reportPage * 12 + 11),
            supabaseClient.from('feedback').select('id,report_id,user_id,message,created_at').eq('user_id',id).not('report_id','is',null).order('created_at',{ascending:false}).order('id').range(state.feedbackPage * 12,state.feedbackPage * 12 + 11)
        ]);
        if (generation !== communityAuthGeneration || profilePages.get(scope) !== state) return;
        if (r.error) throw r.error;
        if (f.error) throw f.error;
        const mapped = (r.data || []).map(row => directoryReport(row));
        await Promise.all(mapped.map(async report=>{if(report.photoPath) report.photo=await signedMediaUrl(report.photoPath);}));
        if (generation !== communityAuthGeneration || profilePages.get(scope) !== state) return;
        mergeCloudReports(mapped);
        if (reset) { reportsTarget.replaceChildren(); notesTarget.replaceChildren(); }
        reportsTarget.querySelector('[data-more-profile]')?.remove(); notesTarget.querySelector('[data-more-profile]')?.remove();
        reportsTarget.insertAdjacentHTML('beforeend', mapped.map(reportCardMarkup).join('') || (reset ? '<p class="muted">No accessible reports from this member yet.</p>' : ''));
        notesTarget.insertAdjacentHTML('beforeend', (f.data || []).map(note => `<article class="member-feedback-item">${authorMarkup(note.user_id, formatSubmittedDate(note.created_at), 'Community member')}<p>${escapeHTML(note.message)}</p><button class="view-report-button" data-open-cloud-report="${escapeHTML(note.report_id)}">View report</button></article>`).join('') || (reset ? '<p class="muted">No accessible feedback contributions yet.</p>' : ''));
        if (r.data?.length === 12 || f.data?.length === 12) {
            notesTarget.insertAdjacentHTML('beforeend', `<button type="button" class="secondary-dialog-button" data-more-profile="${scope}">Load more activity</button>`);
        }
        state.reportPage++; state.feedbackPage++;
    } catch (error) {
        console.warn('CleanMap profile activity failed:', error);
        if (generation !== communityAuthGeneration || profilePages.get(scope) !== state) return;
        if (reset) { reportsTarget.textContent = 'Reports could not be loaded. Please try again.'; notesTarget.replaceChildren(); }
        else showToast('Could not load more activity. Please try again.');
    } finally { state.busy=false; }
}
function resetAvatarDraft() {
    avatarSelectionVersion++;
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    avatarPreviewUrl=''; avatarDraft=null; removeAvatarDraft=false;
}
async function openProfileEditor() {
    if (!currentUser || !supabaseClient) { showToast('Sign in to edit your profile.'); return; }
    const id = currentUser.id;
    await fetchPublicProfiles([id]);
    if (currentUser?.id !== id) return;
    const profile = publicProfiles.get(id);
    if (!profile) { showToast('Your profile is unavailable. Please try again.'); return; }
    profileEditorOwner=id; resetAvatarDraft(); $('saveProfileButton').disabled=false;
    const form=$('profileEditForm'); form.reset();
    for (const field of ['username','display_name','bio','city','barangay']) form.elements.namedItem(field).value=profile[field] || '';
    $('avatarPreview').innerHTML=avatarMarkup(profile,true);
    $('profileEditStatus').textContent='Your name, photo, biography and location are public. Do not include private contact details.';
    $('profileEditDialog').showModal();
}
async function prepareAvatar(file) {
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>2*1024*1024) throw new Error('Choose a JPEG, PNG or WebP image up to 2 MB.');
    const bitmap=await createImageBitmap(file);
    try {
        if (bitmap.width>12000 || bitmap.height>12000) throw new Error('Choose a smaller image (up to 12,000 pixels per side).');
        const canvas=document.createElement('canvas'); const side=Math.min(bitmap.width,bitmap.height);
        canvas.width=canvas.height=Math.min(512,side);
        canvas.getContext('2d').drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,canvas.width,canvas.height);
        return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob ? resolve(blob) : reject(new Error('Could not read this image.')),'image/jpeg',.88));
    } finally { bitmap.close(); }
}
async function saveProfile(event) {
    event.preventDefault();
    const form=event.currentTarget, button=$('saveProfileButton');
    if (button.disabled || !currentUser || currentUser.id !== profileEditorOwner) return;
    const owner=currentUser.id, generation=communityAuthGeneration;
    const oldProfile=publicProfiles.get(owner); let uploadPath=null, saved=false;
    const values=Object.fromEntries(new FormData(form));
    if (!/^[a-z0-9_]{3,30}$/.test(values.username.trim().toLowerCase())) { $('profileEditStatus').textContent='Use 3–30 letters, numbers or underscores for your username.'; return; }
    [...form.elements].forEach(element=>{element.disabled=true;}); form.setAttribute('aria-busy','true'); $('profileEditStatus').textContent='Saving your profile…';
    try {
        let avatar=removeAvatarDraft ? null : oldProfile.avatar_url;
        if (avatarDraft) {
            uploadPath=`${owner}/${crypto.randomUUID()}.jpg`;
            const { error }=await supabaseClient.storage.from('cleanmap-avatars').upload(uploadPath,avatarDraft,{contentType:'image/jpeg',upsert:false});
            if (error) throw error;
            avatar=supabaseClient.storage.from('cleanmap-avatars').getPublicUrl(uploadPath).data.publicUrl;
        }
        if (generation !== communityAuthGeneration || currentUser?.id !== owner) throw new Error('Your session changed. Please sign in and try again.');
        const {error}=await supabaseClient.rpc('cleanmap_save_profile',{p_username:values.username,p_display_name:values.display_name,p_bio:values.bio,p_city:values.city,p_barangay:values.barangay,p_avatar_url:avatar || null});
        if (error) throw error;
        saved=true;
        const prefix=`${CLEANMAP_SUPABASE_URL}/storage/v1/object/public/cleanmap-avatars/`;
        if (oldProfile.avatar_url?.startsWith(prefix+owner+'/') && oldProfile.avatar_url !== avatar) {
            const {error:cleanupError}=await supabaseClient.storage.from('cleanmap-avatars').remove([oldProfile.avatar_url.slice(prefix.length)]);
            if (cleanupError) console.warn('CleanMap old avatar cleanup failed:',cleanupError);
        }
        if (generation !== communityAuthGeneration) return;
        publicProfiles.delete(owner); await fetchPublicProfiles([owner]);
        $('profileEditDialog').close(); await loadOwnProfile();
        if ($('page-member').classList.contains('active')) await openPublicProfile(owner);
        showToast('Your profile was updated.');
    } catch(error) {
        console.warn('CleanMap profile save failed:',error);
        if (uploadPath && !saved && currentUser?.id===owner) await supabaseClient.storage.from('cleanmap-avatars').remove([uploadPath]);
        $('profileEditStatus').textContent=error.code==='23505' ? 'That username is already taken. Please choose another.' : 'Could not save your profile. Your changes are still here; check your connection and try again.';
    } finally { [...form.elements].forEach(element=>{element.disabled=false;}); form.removeAttribute('aria-busy'); }
}
function initializeCommunityUI() {
    communityReady=true;
    document.addEventListener('error',event=>{
        if (event.target.matches?.('.member-avatar img')) event.target.replaceWith(document.createTextNode('◉'));
    },true);
    document.addEventListener('click',event=>{
        const profile=event.target.closest('[data-public-profile]');
        if (profile) openPublicProfile(profile.dataset.publicProfile);
        if (event.target.closest('[data-edit-profile]')) openProfileEditor();
        const more=event.target.closest('[data-more-profile]');
        if (more) { const state=profilePages.get(more.dataset.moreProfile); if (state) loadProfileActivity(state.id,more.dataset.moreProfile); }
    });
    $('profileEditForm').addEventListener('submit',saveProfile);
    $('profileEditClose').addEventListener('click',()=>$('profileEditDialog').close());
    $('profileEditDialog').addEventListener('close',resetAvatarDraft);
    $('profileAvatarFile').addEventListener('change',async event=>{
        const file=event.target.files[0]; if (!file) return;
        const owner=profileEditorOwner,selection=++avatarSelectionVersion;
        $('saveProfileButton').disabled=true;
        try {
            const blob=await prepareAvatar(file);
            if (selection!==avatarSelectionVersion || owner!==profileEditorOwner || !$('profileEditDialog').open) return;
            if(avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
            removeAvatarDraft=false; avatarDraft=blob; avatarPreviewUrl=URL.createObjectURL(blob);
            $('avatarPreview').innerHTML=`<span class="member-avatar member-avatar-large"><img src="${avatarPreviewUrl}" alt="New profile picture preview"></span>`;
            $('profileEditStatus').textContent='Preview ready. Save your profile to upload this picture.';
        } catch(error) { if(selection===avatarSelectionVersion) $('profileEditStatus').textContent=error.message; }
        finally { if(selection===avatarSelectionVersion) $('saveProfileButton').disabled=false; }
    });
    $('removeAvatarButton').addEventListener('click',()=>{ resetAvatarDraft(); removeAvatarDraft=true; $('saveProfileButton').disabled=false; $('profileAvatarFile').value=''; $('avatarPreview').innerHTML=avatarMarkup(null,true); });
}

const DIRECTORY_FIELDS = 'id,reporter_id,location,pollution_type,severity,reporter_severity,description,latitude,longitude,photo_url,video_url,created_at,verification_status,city,barangay,vote_counts,activity_count,severity_rank';
let explorePage = 0;
let exploreRequest = 0;
let detailRequest = 0;
let exploreLoaded = false;
let cloudStatistics = null;
let communityPreviousPage = 'explore';
function formatSubmittedDate(value) { return value && !Number.isNaN(new Date(value).valueOf()) ? new Date(value).toLocaleString() : 'Date not recorded'; }
function directoryQuery() { return supabaseClient.from('cleanmap_report_directory').select(DIRECTORY_FIELDS,{count:'exact'}); }
function directoryReport(row) {
    const report=mapCloudReport(row);
    report.votes={...report.votes,...(row.vote_counts || {})};
    report.reporterSeverity=safeSeverity(row.reporter_severity || row.severity);
    report.activityCount=Number(row.activity_count || 0);
    const summary=renderVoteSummary(report); if(summary.verified) report.severity=summary.top;
    return report;
}
function mergeCloudReports(items) {
    const map=new Map(reports.map(report=>[String(report.id),report]));
    items.forEach(report=>{
        const previous=map.get(String(report.id));
        // Directory/profile rows omit feedback and media. Preserve hydrated details.
        if(previous?.detailsLoaded && !report.detailsLoaded) report={...previous,...report,
            notes:previous.notes,myVote:previous.myVote,detailsLoaded:true,notesHasMore:previous.notesHasMore,
            photo:report.photo || previous.photo,videoUrl:report.videoUrl || previous.videoUrl};
        map.set(String(report.id),report);
    });
    reports=[...map.values()];
}
function reportCardMarkup(report) {
    return `<article class="explore-card">${report.photo ? `<img class="explore-thumbnail" src="${escapeHTML(report.photo)}" alt="Evidence at ${escapeHTML(report.location)}" loading="lazy">` : ''}<div class="explore-card-body"><div><span class="pill ${safeSeverity(report.severity)}-pill">${capitalize(safeSeverity(report.severity))}</span> <span class="muted">${escapeHTML(report.type)}</span></div><h3>${escapeHTML(report.location || 'Pollution report')}</h3><p class="explore-description">${escapeHTML(report.description)}</p><small class="muted">${escapeHTML([report.barangay,report.city].filter(Boolean).join(', ') || 'Area not recorded')}</small>${authorMarkup(report.reporterId,report.date)}<small class="muted">${escapeHTML(report.verificationStatus)} · ${report.activityCount ?? renderVoteSummary(report).total} contribution(s)</small><div class="explore-card-actions"><button type="button" class="view-report-button" data-open-cloud-report="${escapeHTML(report.dbId)}">View details</button><button type="button" class="secondary-dialog-button" data-report-map="${escapeHTML(report.id)}">View on map</button></div></div></article>`;
}
async function loadExplore(reset=false) {
    if (reset) explorePage=0;
    const request=++exploreRequest, generation=communityAuthGeneration;
    const target=$('exploreResults');
    if (!currentUser || !supabaseClient) {
        target.innerHTML='<div class="explore-empty"><h2>Explore your community</h2><p>Sign in to browse shared reports. Report access follows CleanMap’s existing privacy settings.</p><button type="button" class="view-report-button" data-open-account>Sign in</button></div>';
        $('exploreStatus').textContent='Community reports'; $('exploreNext').disabled=true; $('explorePrevious').disabled=true; return;
    }
    target.setAttribute('aria-busy','true'); $('exploreStatus').textContent='Loading reports…';
    $('exploreNext').disabled=true; $('explorePrevious').disabled=true;
    try {
        let query=directoryQuery();
        for(const [field,id] of [['pollution_type','exploreType'],['severity','exploreSeverity'],['city','exploreCity'],['barangay','exploreBarangay'],['verification_status','exploreStatusFilter']]) {
            if ($(id).value) query=query.eq(field,$(id).value);
        }
        const search=$('exploreSearch').value.trim().slice(0,120);
        // PostgREST filter grammar is not an SQL parameter: strip its metacharacters.
        const normalized=search.replace(/[,%*()."\\]/g,' ').trim();
        if(normalized) query=query.or(`location.ilike.%${normalized}%,description.ilike.%${normalized}%,city.ilike.%${normalized}%,barangay.ilike.%${normalized}%`);
        const sort=$('exploreSort').value;
        if(sort==='severity') query=query.order('severity_rank',{ascending:false});
        if(sort==='activity') query=query.order('activity_count',{ascending:false});
        const {data,error,count}=await query.order('created_at',{ascending:false}).order('id').range(explorePage*COMMUNITY_PAGE_SIZE,(explorePage+1)*COMMUNITY_PAGE_SIZE-1);
        if(error) throw error;
        const mapped=(data || []).map(directoryReport);
        await fetchPublicProfiles(mapped.map(report=>report.reporterId));
        await Promise.all(mapped.map(async report=>{ if(report.photoPath) report.photo=await signedMediaUrl(report.photoPath); }));
        if(request!==exploreRequest || generation!==communityAuthGeneration) return;
        mergeCloudReports(mapped);
        target.innerHTML=mapped.map(reportCardMarkup).join('') || '<div class="explore-empty"><h2>No reports match these filters</h2><p>Try another area or clear your filters. No reports have been added for demonstration.</p></div>';
        $('exploreStatus').textContent=`${count ?? mapped.length} matching report${count===1?'':'s'}`;
        $('explorePageNumber').textContent=`Page ${explorePage+1}`;
        $('explorePrevious').disabled=explorePage===0;
        $('exploreNext').disabled=(explorePage+1)*COMMUNITY_PAGE_SIZE>=(count ?? 0);
        exploreLoaded=true;
    } catch(error) {
        console.warn('CleanMap directory failed:',error);
        if(request!==exploreRequest || generation!==communityAuthGeneration) return;
        $('exploreStatus').textContent='Reports could not be loaded.';
        target.innerHTML='<div class="explore-empty"><p>Check your connection and try again.</p><button type="button" class="view-report-button" id="retryExplore">Retry</button></div>';
        $('retryExplore').addEventListener('click',()=>loadExplore());
    } finally { if(request===exploreRequest) target.removeAttribute('aria-busy'); }
}
let reportAreaOptions=[];
async function loadReportAreas() {
    if (!supabaseClient || !currentUser) return;
    const generation=communityAuthGeneration;
    const {data,error}=await supabaseClient.rpc('cleanmap_report_areas');
    if(error || generation!==communityAuthGeneration) return;
    reportAreaOptions=data || [];
    const cities=[...new Set(reportAreaOptions.map(area=>area.city).filter(Boolean))];
    const selected=$('exploreCity').value;
    $('exploreCity').innerHTML='<option value="">All Cebu areas</option>'+cities.map(city=>`<option>${escapeHTML(city)}</option>`).join('');
    if(cities.includes(selected)) $('exploreCity').value=selected;
    updateBarangayOptions();
}
function updateBarangayOptions() {
    const city=$('exploreCity').value, select=$('exploreBarangay'), previous=select.value;
    const areas=[...new Set(reportAreaOptions.filter(area=>area.city===city).map(area=>area.barangay).filter(Boolean))];
    select.innerHTML='<option value="">All barangays</option>'+areas.map(area=>`<option>${escapeHTML(area)}</option>`).join('');
    select.disabled=!city; if(areas.includes(previous)) select.value=previous;
}
async function openCloudReport(dbId, onMap=false) {
    if(!supabaseClient || !currentUser) { showToast('Sign in to view this report.'); return; }
    const request=++detailRequest,generation=communityAuthGeneration;
    const focused=document.activeElement; const focusId=focused?.id; const focusVote=focused?.dataset.voteSeverity;
    showToast('Loading report details…');
    try {
        const [r,v,f]=await Promise.all([
            supabaseClient.from('reports').select('id,reporter_id,location,pollution_type,severity,description,latitude,longitude,photo_url,video_url,created_at,verification_status,city,barangay').eq('id',dbId).single(),
            supabaseClient.from('report_votes').select('id,report_id,user_id,severity').eq('report_id',dbId),
            supabaseClient.from('feedback').select('id,report_id,user_id,message,created_at').eq('report_id',dbId).order('created_at',{ascending:false}).order('id').limit(30)
        ]);
        if(r.error) throw r.error; if(v.error) throw v.error; if(f.error) throw f.error;
        const report=mapCloudReport(r.data,v.data || [],f.data || []);
        await fetchPublicProfiles([report.reporterId,...(f.data || []).map(note=>note.user_id)]);
        [report.photo,report.videoUrl]=await Promise.all([signedMediaUrl(report.photoPath || report.photo),signedMediaUrl(report.videoPath || report.videoUrl)]);
        if(request!==detailRequest || generation!==communityAuthGeneration) return;
        report.detailsLoaded=true; report.notesHasMore=f.data?.length===30;
        const summary=renderVoteSummary(report); if(summary.verified) report.severity=summary.top;
        mergeCloudReports([report]);
        if(onMap) { switchPage('map'); if(Number.isFinite(report.lat)&&Number.isFinite(report.lng)) cleanMapInstance?.setView([report.lat,report.lng],15); }
        selectLocation(report.id);
        if(document.activeElement===focused || document.activeElement===document.body) {
            const replacement=focusId ? $(focusId) : focusVote ? $('detailsCard').querySelector(`[data-vote-severity="${focusVote}"]`) : null;
            replacement?.focus({preventScroll:true});
        }
        renderReportMarkers();
    } catch(error) {
        console.warn('CleanMap report details failed:',error);
        if(request===detailRequest && generation===communityAuthGeneration) showToast('This report is unavailable or you do not have access. Please try again.');
    }
}
async function loadMoreFeedback(report) {
    if(report.loadingNotes) return; report.loadingNotes=true;
    const generation=communityAuthGeneration;
    const {data,error}=await supabaseClient.from('feedback').select('id,report_id,user_id,message,created_at').eq('report_id',report.dbId).order('created_at',{ascending:false}).order('id').range(report.notes.length,report.notes.length+29);
    report.loadingNotes=false;
    if(error) { showToast('Could not load more feedback.'); return; }
    await fetchPublicProfiles((data || []).map(note=>note.user_id));
    if(generation!==communityAuthGeneration) return;
    report.notes.push(...(data || []).map(note=>({id:note.id,userId:note.user_id,text:note.message,date:formatSubmittedDate(note.created_at)})));
    report.notesHasMore=data?.length===30;
    if(String(selectedLocation?.id)===String(report.id)) selectLocation(report.id);
}
function feedbackMarkup(note, report) {
    const canEdit=note.id && currentUser && (note.userId===currentUser.id || currentRole==='admin');
    return `<blockquote>${authorMarkup(note.userId,note.date,'Community member')}<p>${escapeHTML(note.text)}</p>${canEdit ? `<div class="feedback-actions"><button type="button" class="view-report-button" data-edit-feedback="${escapeHTML(note.id)}" data-feedback-report="${escapeHTML(report.id)}">Edit</button><button type="button" class="danger-button" data-delete-feedback="${escapeHTML(note.id)}" data-feedback-report="${escapeHTML(report.id)}">Delete</button></div>` : ''}</blockquote>`;
}
let feedbackEditing=null;
async function mutateFeedback(event) {
    event.preventDefault();
    if(!feedbackEditing || !currentUser) return;
    const button=$('feedbackSave'); if(button.disabled) return;
    const {report,note,deleting}=feedbackEditing,owner=currentUser.id;
    if(note.userId!==owner && currentRole!=='admin') return;
    button.disabled=true; $('feedbackEditStatus').textContent=deleting?'Deleting…':'Saving…';
    try {
        let query=deleting ? supabaseClient.from('feedback').delete() : supabaseClient.from('feedback').update({message:$('feedbackText').value.trim()});
        const {data,error}=await query.eq('id',note.id).eq('report_id',report.dbId).select('id');
        if(error) throw error;
        if(!data?.length) throw new Error('Change not permitted');
        $('feedbackEditDialog').close();
        if(currentUser?.id===owner) { await openCloudReport(report.dbId); showToast(deleting?'Feedback deleted.':'Feedback updated.'); loadOwnProfile(); }
    } catch(error) { console.warn('CleanMap feedback change failed:',error); $('feedbackEditStatus').textContent='Could not change this feedback. Check your connection and permissions.'; }
    finally {button.disabled=false;}
}
function setupExploreAndAuthors() {
    $('exploreFilters').addEventListener('submit',event=>{event.preventDefault();loadExplore(true);});
    for(const id of ['exploreType','exploreSeverity','exploreCity','exploreBarangay','exploreStatusFilter','exploreSort']) $(id).addEventListener('change',()=>{if(id==='exploreCity') { $('exploreBarangay').value=''; updateBarangayOptions(); } loadExplore(true);});
    $('explorePrevious').addEventListener('click',()=>{if(explorePage>0) {explorePage--;loadExplore();}});
    $('exploreNext').addEventListener('click',()=>{explorePage++;loadExplore();});
    $('exploreClear').addEventListener('click',()=>{$('exploreFilters').reset();updateBarangayOptions();loadExplore(true);});
    $('feedbackEditForm').addEventListener('submit',mutateFeedback);
    $('feedbackEditClose').addEventListener('click',()=>$('feedbackEditDialog').close());
    document.addEventListener('click',event=>{
        const open=event.target.closest('[data-open-cloud-report]'); if(open) openCloudReport(open.dataset.openCloudReport);
        const map=event.target.closest('[data-report-map]'); if(map) {const report=reports.find(r=>String(r.id)===map.dataset.reportMap);if(report) openCloudReport(report.dbId,true);}
        if(event.target.closest('[data-open-account]')) $('accountButton').click();
        if(event.target.closest('[data-community-back]')) switchPage(communityPreviousPage);
        const more=event.target.closest('[data-more-feedback]'); if(more) {const report=reports.find(r=>String(r.id)===more.dataset.moreFeedback); if(report) loadMoreFeedback(report);}
        const edit=event.target.closest('[data-edit-feedback],[data-delete-feedback]');
        if(edit) {
            const report=reports.find(r=>String(r.id)===edit.dataset.feedbackReport);
            const note=report?.notes.find(n=>String(n.id)===String(edit.dataset.editFeedback || edit.dataset.deleteFeedback));
            if(!note || !currentUser || (note.userId!==currentUser.id && currentRole!=='admin')) return;
            feedbackEditing={report,note,deleting:Boolean(edit.dataset.deleteFeedback)};
            $('feedbackText').value=note.text; $('feedbackText').hidden=feedbackEditing.deleting; $('feedbackText').required=!feedbackEditing.deleting;
            $('feedbackEditTitle').textContent=feedbackEditing.deleting?'Delete this feedback?':'Edit feedback';
            $('feedbackSave').textContent=feedbackEditing.deleting?'Delete feedback':'Save feedback';
            $('feedbackEditStatus').textContent=feedbackEditing.deleting?'This action cannot be undone.':'Use observable evidence and respectful language.';
            $('feedbackEditDialog').showModal();
        }
    });
}

const CLEANMAP_PRODUCTION_ORIGIN='https://cleanmap-chi.vercel.app';
function authRedirectURL(origin=location.origin,recovery=false) {
    const allowed=[CLEANMAP_PRODUCTION_ORIGIN,'http://localhost:3000','http://127.0.0.1:3000'];
    if(!allowed.includes(origin)) throw new Error('Sign-in redirects are not configured for this domain. Use the main CleanMap website.');
    return `${origin}/${recovery?'?recovery=1':''}`;
}
function clearCommunitySession() {
    communityAuthGeneration++; ownProfileRequest++; profileRequest++; detailRequest++; exploreRequest++;
    profilePages.clear(); publicProfiles.clear(); cloudStatistics=null; exploreLoaded=false;
    profileEditorOwner=null; resetAvatarDraft();
    $('profileEditDialog')?.close(); $('feedbackEditDialog')?.close(); clearDetails();
    reports=reports.filter(report=>report.cloudReport!==true);
    $('selfProfileView').innerHTML='<h2>Your place in the community</h2><p>Sign in to personalize your profile and see your contributions.</p>';
    $('publicProfileView').replaceChildren(); $('memberReports').replaceChildren(); $('memberFeedback').replaceChildren();
    $('ownFeedback').textContent='Sign in to see your contributions.';
    $('adminReportsList').replaceChildren(); $('adminFeedbackList').replaceChildren();
    for(const id of ['adminTotalReports','adminPendingReports','adminFeedbackCount']) $(id).textContent='0';
    renderReportMarkers(); updateStatistics(); updateProfile();
    if($('page-member').classList.contains('active')) switchPage('profile');
    if($('page-explore').classList.contains('active')) loadExplore();
}
async function initializeMemberProfile() {
    if(!currentUser || !supabaseClient) return;
    const owner=currentUser.id;
    const {error}=await supabaseClient.rpc('cleanmap_ensure_profile');
    if(error) {console.warn('CleanMap profile initialization unavailable:',error);return;}
    if(currentUser?.id===owner) {await fetchPublicProfiles([owner]); await loadOwnProfile();}
}
async function loadCloudStatistics() {
    if(!supabaseClient || !currentUser) return;
    const generation=communityAuthGeneration;
    const {data,error}=await supabaseClient.rpc('cleanmap_report_statistics');
    if(generation!==communityAuthGeneration) return;
    cloudStatistics=error?null:data; updateStatistics();
}
