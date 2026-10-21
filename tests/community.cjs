/* Isolated UI/API-contract coverage; NOT a live OAuth/Supabase authorization test. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require(process.env.CLEANMAP_PLAYWRIGHT_MODULE || 'playwright-core');
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.CLEANMAP_BROWSER_CDP);
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 await context.route('**/npm/@supabase/supabase-js@2',route=>route.fulfill({path:path.join(__dirname,'fixtures/community-client.js'),contentType:'application/javascript'}));
 await context.route('**/*.supabase.co/**',route=>route.abort());
 await context.addInitScript(()=>{if(location.origin!=='null')localStorage.setItem('cleanmapWelcomeSeen','true');});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try {
  await page.goto('http://localhost:3000/',{waitUntil:'networkidle'});
  await page.locator('[data-page="explore"]').click();
  assert.match(await page.locator('#exploreResults').innerText(),/Sign in/);
  await page.locator('#accountButton').click();
  for(const provider of ['google','facebook']) {
   await page.locator(`[data-oauth-provider="${provider}"]`).click();
   await page.waitForFunction(()=>document.getElementById('accountStatus').textContent.includes('provider may not be enabled'));
  }
  const oauth=await page.evaluate(()=>communityFixture.calls.filter(c=>c.oauth).map(c=>c.oauth));
  assert.deepEqual(oauth.map(c=>c.provider),['google','facebook']);
  oauth.forEach(call=>assert.equal(call.options.redirectTo,'http://localhost:3000/'));
  assert(await page.evaluate(()=>{try {authRedirectURL('https://attacker.invalid');return false;}catch{return true;}}));
  assert.equal(await page.evaluate(()=>communityFixture.clientOptions.auth.flowType),'pkce');
  await page.locator('#accountReset').click();await page.locator('#accountEmail').fill('member@example.invalid');await page.locator('#accountSubmit').click();
  await page.waitForFunction(()=>document.getElementById('accountStatus').textContent.includes('If this email'));
  assert.equal(await page.evaluate(()=>communityFixture.calls.find(c=>c.reset).redirectTo),'http://localhost:3000/?recovery=1');
  await page.locator('#accountModeSwitch').click();await page.locator('#accountModeSwitch').click();
  await page.locator('#accountDisplayName').fill('Registration fixture');await page.locator('#accountPassword').fill('Test-only-password');await page.locator('#accountSubmit').click();
  await page.waitForFunction(()=>document.getElementById('accountStatus').textContent.includes('Check your email'));
  assert.equal(await page.evaluate(()=>communityFixture.calls.find(c=>c.signup).signup.options.emailRedirectTo),'https://cleanmap-chi.vercel.app/');
  await page.locator('#accountModeSwitch').click();await page.locator('#accountPassword').fill('Test-only-password');await page.locator('#accountSubmit').click();
  await page.waitForFunction(()=>currentUser && !document.getElementById('accountDialog').open && document.querySelectorAll('#exploreResults .explore-card').length===12);
  console.log('PASS email login/registration/reset contracts, provider actions/failure states, PKCE and redirect allowlist');
  assert.equal(await page.locator('#exploreStatus').innerText(),'25 matching reports');
  await page.locator('#exploreNext').click();await page.waitForFunction(()=>document.getElementById('explorePageNumber').textContent==='Page 2');
  assert.equal(await page.locator('#exploreResults .explore-card').count(),12);
  await page.locator('#exploreNext').click();await page.waitForFunction(()=>document.getElementById('explorePageNumber').textContent==='Page 3');
  assert.equal(await page.locator('#exploreResults .explore-card').count(),1);assert(await page.locator('#exploreNext').isDisabled());
  assert.match(await page.locator('#exploreResults').innerText(),/Community report/);
  await page.locator('#exploreCity').selectOption('Lapu-Lapu City');await page.waitForFunction(()=>document.getElementById('exploreStatus').textContent==='12 matching reports');
  assert.equal(await page.locator('#explorePageNumber').innerText(),'Page 1');
  await page.locator('#exploreType').selectOption('Air Pollution');await page.waitForFunction(()=>document.getElementById('exploreResults').textContent.includes('No reports match'));
  await page.locator('#exploreType').selectOption('Water Pollution');await page.waitForFunction(()=>document.getElementById('exploreStatus').textContent==='12 matching reports');
  await page.locator('#exploreType').selectOption('');
  await page.locator('#exploreCity').selectOption('Cebu City');await page.locator('#exploreBarangay').selectOption('Lahug');
  await page.locator('#exploreStatusFilter').selectOption('Verified');await page.waitForFunction(()=>document.getElementById('exploreResults').textContent.includes('No reports match'));
  await page.locator('#exploreStatusFilter').selectOption('');
  await page.locator('#exploreSeverity').selectOption('high');await page.waitForFunction(()=>!document.getElementById('exploreResults').hasAttribute('aria-busy'));
  assert(await page.locator('#exploreResults .explore-card').count()>0);
  await page.locator('#exploreSearch').fill('no matching observation');await page.locator('#exploreFilters [type="submit"]').click();await page.waitForFunction(()=>document.getElementById('exploreResults').textContent.includes('No reports match'));
  await page.locator('#exploreClear').click();await page.waitForFunction(()=>document.querySelectorAll('#exploreResults .explore-card').length===12);
  await page.locator('#exploreSort').selectOption('severity');await page.waitForFunction(()=>!document.getElementById('exploreResults').hasAttribute('aria-busy'));
  assert.equal(await page.locator('#exploreResults .pill').first().innerText(),'High');
  await page.locator('#exploreSort').selectOption('activity');await page.waitForFunction(()=>!document.getElementById('exploreResults').hasAttribute('aria-busy'));
  await page.locator('#exploreResults [data-open-cloud-report]').first().click();await page.waitForFunction(()=>document.getElementById('reportDetailsDialog').open);
  assert.match(await page.locator('#detailsCard .report-information-section .report-author').first().innerText(),/River watcher/);
  await page.locator('.community-feedback summary').click();
  assert.match(await page.locator('.community-notes-list').innerText(),/Coast watcher/);
  assert.equal(await page.locator('[data-delete-feedback]').count(),0);
  await page.locator('[name="communityNote"]').fill('<img src=x onerror=alert(1)> Safe rendering');
  await page.locator('[data-note-form] button').click();await page.waitForFunction(()=>document.querySelector('.community-notes-list')?.textContent.includes('Safe rendering'));
  assert.equal(await page.locator('.community-notes-list img[src="x"]').count(),0);
  await page.locator('[data-edit-feedback]').click();await page.locator('#feedbackText').fill('Edited feedback');await page.locator('#feedbackSave').click();
  await page.waitForFunction(()=>!document.getElementById('feedbackEditDialog').open && document.querySelector('.community-notes-list')?.textContent.includes('Edited feedback'));
  await page.locator('[data-delete-feedback]').click(); await page.locator('#feedbackSave').click();await page.waitForFunction(()=>!document.getElementById('feedbackEditDialog').open && !document.querySelector('.community-notes-list')?.textContent.includes('Edited feedback'));
  await page.locator('#closeDetails').click();assert.equal(await page.locator('#exploreSort').inputValue(),'activity');
  await page.locator('#exploreResults [data-public-profile]').first().click();await page.waitForFunction(()=>document.querySelector('#publicProfileView h2')?.textContent==='River watcher');
  assert(await page.locator('#publicProfileView [data-edit-profile]').isVisible());
  await page.evaluate(()=>openPublicProfile(communityFixture.userB.id));
  assert.equal(await page.locator('#publicProfileView [data-edit-profile]').count(),0);
  assert(!(await page.locator('#page-member').innerText()).includes('private-b@example.invalid'));
  console.log('PASS paginated directory, real-record counts, area/type/severity/search filters, empty state, author links, escaped feedback and owner actions');
  await page.locator('[data-page="profile"]').click();await page.waitForFunction(()=>document.querySelector('#selfProfileView [data-edit-profile]'));
  await page.locator('#selfProfileView [data-edit-profile]').click();
  await page.locator('#profileEditForm [name="username"]').fill('updated_member');await page.locator('#profileEditForm [name="bio"]').fill('Updated public biography');
  await page.evaluate(()=>communityFixture.failSave=true);await page.locator('#saveProfileButton').click();await page.waitForFunction(()=>document.getElementById('profileEditStatus').textContent.includes('already taken'));
  assert.equal(await page.locator('#profileEditForm [name="bio"]').inputValue(),'Updated public biography');
  await page.evaluate(()=>communityFixture.failSave=false);
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=20;c.getContext('2d').fillRect(0,0,20,20);return c.toDataURL('image/png').split(',')[1];});
  await page.locator('#profileAvatarFile').setInputFiles({name:'avatar.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
  await page.waitForFunction(()=>document.getElementById('profileEditStatus').textContent.includes('JPEG, PNG or WebP'));
  await page.locator('#profileAvatarFile').setInputFiles({name:'large.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(2*1024*1024+1)});
  await page.waitForFunction(()=>document.getElementById('profileEditStatus').textContent.includes('up to 2 MB'));
  await page.locator('#profileAvatarFile').setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.waitForFunction(()=>document.getElementById('profileEditStatus').textContent.includes('Preview ready'));
  assert.equal(await page.evaluate(()=>communityFixture.uploads.length),0,'Preview does not upload');
  await page.locator('#saveProfileButton').click();await page.waitForFunction(()=>!document.getElementById('profileEditDialog').open);
  assert.match(await page.locator('#selfProfileView').innerText(),/@updated_member/);
  const upload=await page.evaluate(()=>communityFixture.uploads[0]);assert.equal(upload.type,'image/jpeg');assert(upload.path.startsWith('00000000-0000-0000-0000-000000000001/'));
  for(const action of ['replace','remove']) {
   await page.locator('#selfProfileView [data-edit-profile]').click();
   if(action==='replace') {await page.locator('#profileAvatarFile').setInputFiles({name:'another.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await page.waitForFunction(()=>document.getElementById('profileEditStatus').textContent.includes('Preview ready'));}
   else await page.locator('#removeAvatarButton').click();
   await page.locator('#saveProfileButton').click();await page.waitForFunction(()=>!document.getElementById('profileEditDialog').open);
  }
  assert.equal(await page.evaluate(()=>communityFixture.removals.length),2);
  assert.equal(await page.evaluate(()=>communityFixture.profiles[0].avatar_url),null);
  for(const [width,height] of [[1440,1000],[768,1024],[390,844],[320,780]]) {
   await page.setViewportSize({width,height});await page.locator('[data-page="explore"]').click();await page.waitForFunction(()=>!document.getElementById('exploreResults').hasAttribute('aria-busy'));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Directory fits ${width}`);
   await page.locator('[data-page="profile"]').click();await page.locator('#selfProfileView [data-edit-profile]').click();
   const box=await page.locator('#profileEditDialog').boundingBox();assert(box.x>=0&&box.x+box.width<=width&&box.y>=0&&box.y+box.height<=height);
   await page.locator('#profileEditClose').click();
  }
  await page.locator('#accountButton').click();await page.locator('#accountSignOut').click();await page.waitForFunction(()=>currentUser===null && document.getElementById('accountStatus').textContent.includes('signed out'));
  await page.locator('#accountDialogClose').click();
  assert(!(await page.locator('#selfProfileView').innerText()).includes('Updated public biography'));
  assert.equal(await page.evaluate(()=>reports.filter(r=>r.cloudReport).length),0);
  // First and repeat OAuth sessions are simulated here; no provider exchange is claimed.
  await page.evaluate(()=>{communityFixture.user={id:'00000000-0000-0000-0000-000000000004',user_metadata:{full_name:'OAuth fixture'}};communityFixture.callbacks.forEach(cb=>cb('SIGNED_IN',{user:communityFixture.user}));});
  await page.waitForFunction(()=>document.querySelector('#selfProfileView h2')?.textContent==='OAuth fixture');
  await page.evaluate(()=>communityFixture.callbacks.forEach(cb=>cb('SIGNED_IN',{user:communityFixture.user})));
  await page.waitForFunction(()=>communityFixture.calls.filter(c=>c.rpc==='cleanmap_ensure_profile').length>=2);
  assert.equal(await page.evaluate(()=>communityFixture.profiles.filter(p=>p.id===communityFixture.user.id).length),1);
  await page.goto('http://localhost:3000/?error=access_denied&next=https://attacker.invalid/',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.getElementById('accountDialog').open && document.getElementById('accountStatus').textContent.includes('cancelled'));
  assert.equal(new URL(page.url()).origin,'http://localhost:3000');assert.equal(new URL(page.url()).search,'');
  await page.evaluate(()=>{communityFixture.user=communityFixture.userA;communityFixture.callbacks.forEach(cb=>cb('PASSWORD_RECOVERY',{user:communityFixture.user}));});
  await page.waitForFunction(()=>document.getElementById('accountDialogTitle').textContent==='Choose a new password' && !document.getElementById('accountForm').hidden);
  await page.locator('#accountPassword').fill('Test-only-new-password');await page.locator('#accountSubmit').click();
  await page.waitForFunction(()=>document.getElementById('accountStatus').textContent==='Your password was updated.');
  assert(await page.evaluate(()=>communityFixture.calls.some(c=>c.passwordUpdate)));
  console.log('PASS cancelled callback cleanup, rejected external return URL and password-recovery session contract');
  assert.deepEqual(errors,[]);
  console.log('PASS profile editing, duplicate username error/draft, image validation/preview/replace/remove, responsive layouts, sign-out clearing and simulated OAuth profile idempotency; no page errors');
 } finally {await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
