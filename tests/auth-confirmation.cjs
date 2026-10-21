/* Official Supabase v2 client, intercepted HTTP only. No live accounts or emails.
 * Production-origin assets are candidate overrides, not a deployed-site test. */
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require(process.env.CLEANMAP_PLAYWRIGHT_MODULE || 'playwright-core');
const production='https://cleanmap-chi.vercel.app';
const root=path.resolve(__dirname,'..');
const user={id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',role:'authenticated',email:'auth-test@example.invalid',email_confirmed_at:'2026-10-21T10:00:00Z',created_at:'2026-10-21T10:00:00Z',user_metadata:{display_name:'Auth fixture'},app_metadata:{provider:'email',providers:['email']}};
const jwt=()=>[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,aud:'authenticated',role:'authenticated'})).toString('base64url'),'c3ludGhldGlj'].join('.');
const session=()=>({access_token:jwt(),refresh_token:'synthetic-refresh-token',expires_in:3600,token_type:'bearer',user});
let sdkSource;
async function setup(browser,origin) {
 const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 const state={signups:[],tokens:[],signupError:null,loginError:null,exchangeError:null,passwordUpdates:[],release:null,gate:null,errors:[]};
 await context.addInitScript(()=>{if(location.origin!=='null')localStorage.setItem('cleanmapWelcomeSeen','true');});
 // Fetch the same official browser client the app uses, with no replacement auth implementation.
 await context.route('**/npm/@supabase/supabase-js@2',async route=>{
  if(!sdkSource) {const response=await route.fetch();assert(response.ok());sdkSource=await response.text();}
  await route.fulfill({body:sdkSource,contentType:'application/javascript'});
 });
 await context.route(`${production}/**`,async route=>{
  const file=new URL(route.request().url()).pathname.slice(1)||'index.html';
  if(['index.html','style.css','design.css','script.js','guides.js','community.js','community.css','welcome-screen.png'].includes(file))
   await route.fulfill({path:path.join(root,file),headers:{'cache-control':'no-store'}});
  else await route.abort();
 });
 await context.route('**/*.supabase.co/**',async route=>{
  const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();
  const send=(data,status=200)=>route.fulfill({status,json:data,headers:{'access-control-allow-origin':'*','x-supabase-api-version':'2024-01-01','access-control-expose-headers':'x-supabase-api-version'}});
  if(url.pathname==='/auth/v1/signup') {
   state.signups.push({url:url.href,body});if(state.gate)await state.gate;
   return state.signupError?send(state.signupError,429):send({...user,email_confirmed_at:null},200);
  }
  if(url.pathname==='/auth/v1/token') {
   const grant=url.searchParams.get('grant_type');state.tokens.push({grant,body});
   const error=grant==='pkce'?state.exchangeError:state.loginError;
   return error?send(error,400):send(session());
  }
  if(url.pathname==='/auth/v1/user') {if(req.method()==='PUT')state.passwordUpdates.push(body);return send(user);}
  if(url.pathname==='/auth/v1/logout')return route.fulfill({status:204});
  if(url.pathname==='/auth/v1/recover')return send({});
  if(url.pathname.startsWith('/rest/v1/')) {
   if(url.pathname==='/rest/v1/profiles')return send({id:user.id,role:'member'});
   if(url.pathname.endsWith('/cleanmap_ensure_profile'))return send(null);
   if(url.pathname.endsWith('/cleanmap_report_statistics'))return send({total:0,low:0,moderate:0,high:0,severe:0,areas:0});
   return send([]);
  }
  throw new Error(`Unexpected intercepted Supabase request: ${req.method()} ${url.pathname}`);
 });
 const page=await context.newPage();page.on('pageerror',error=>state.errors.push(error.message));
 await page.goto(`${origin}/`,{waitUntil:'networkidle'});
 return {context,page,state};
}
async function openSignup(page) {
 await page.locator('#accountButton').click();
 await page.waitForFunction(()=>!cleanMapAuthBusy&&document.getElementById('accountSubmit').textContent==='Sign in');
 await page.locator('#accountModeSwitch').click();
 await page.locator('#accountEmail').fill(user.email);await page.locator('#accountDisplayName').fill('Auth fixture');
 await page.locator('#accountPassword').fill('Synthetic-test-password');
}
const status=(page,text)=>page.waitForFunction(text=>document.getElementById('accountStatus').textContent.includes(text),text);
async function signOut(page) {
 if(!await page.locator('#accountDialog').evaluate(dialog=>dialog.open))await page.locator('#accountButton').click();
 await page.locator('#accountSignOut').click();await page.waitForFunction(()=>currentUser===null&&!cleanMapAuthBusy);
 await page.locator('#accountDialogClose').click();
}
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.CLEANMAP_BROWSER_CDP);
 try {
  for(const origin of ['http://localhost:3000',production]) {
   const {context,page,state}=await setup(browser,origin);
   try {
    await openSignup(page);
    state.gate=new Promise(resolve=>{state.release=resolve;});
    await page.locator('#accountSubmit').click();
    await page.waitForFunction(()=>document.getElementById('accountSubmit').getAttribute('aria-busy')==='true');
    assert.equal(await page.locator('#accountSubmit').innerText(),'Please wait…');
    for(const selector of ['#accountSubmit','#accountModeSwitch','#accountReset','[data-oauth-provider="google"]','[data-oauth-provider="facebook"]'])assert(await page.locator(selector).isDisabled());
    await page.evaluate(()=>{for(let i=0;i<3;i++)document.getElementById('accountForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    state.release();await status(page,'Check your email');await page.waitForLoadState('networkidle');state.gate=null;
    assert.equal(state.signups.length,1,'Only one in-flight signup reaches the SDK HTTP transport');
    assert.equal(new URL(state.signups[0].url).searchParams.get('redirect_to'),`${production}/`);
    assert.equal(state.signups[0].body.code_challenge_method,'s256');assert(state.signups[0].body.code_challenge);
    assert.equal(await page.locator('#accountSubmit').innerText(),'Create account');assert(await page.locator('#accountSubmit').isEnabled());
    assert.equal(await page.locator('#accountSubmit').getAttribute('aria-busy'),null);
    if(origin===production) {
     await page.goto(`${production}/?code=synthetic-confirmation-code`,{waitUntil:'networkidle'});
     await status(page,'You are signed in to CleanMap.');
     assert(await page.locator('#accountDialog').evaluate(dialog=>dialog.open));
     assert.equal(await page.evaluate(()=>currentUser?.id),user.id);
     const exchanges=state.tokens.filter(t=>t.grant==='pkce');assert.equal(exchanges.length,1,'SDK automatically exchanges the callback code exactly once');
     assert(exchanges[0].body.code_verifier);assert.equal(exchanges[0].body.auth_code,'synthetic-confirmation-code');
     assert.equal(new URL(page.url()).search,'');
     await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>currentUser?.id);
     assert.equal(state.tokens.filter(t=>t.grant==='pkce').length,1,'Persisted session does not exchange again');
     await signOut(page);
    } else {
     // A verifier stored on localhost cannot establish a session at the production origin.
     await page.goto(`${production}/?code=cross-origin-confirmation-code`,{waitUntil:'networkidle'});
     await status(page,'Could not sign you in from this link');assert.equal(await page.evaluate(()=>currentUser),null);
     assert.equal(state.tokens.length,0);await page.locator('#accountDialogClose').click();
    }
    // Existing/confirmed-account sign-in still works; common Auth errors are controlled.
    await page.locator('#accountButton').click();await page.locator('#accountEmail').fill(user.email);
    await page.locator('#accountPassword').fill('Synthetic-test-password');
    for(const [code,message] of [['email_not_confirmed','Confirm your email'],['invalid_credentials','email or password is incorrect']]) {
     state.loginError={code,msg:'Untrusted backend text'};await page.locator('#accountSubmit').click();await status(page,message);
     assert(await page.locator('#accountSubmit').isEnabled());
    }
    state.loginError=null;await page.locator('#accountSubmit').click();
    await page.waitForFunction(()=>currentUser && !document.getElementById('accountDialog').open);
    assert.equal(await page.evaluate(()=>currentRole),'member');await signOut(page);
    await openSignup(page);state.signupError={code:'over_email_send_rate_limit',msg:'Email rate limit exceeded'};
    await page.locator('#accountSubmit').click();await status(page,'Too many authentication requests');await page.waitForLoadState('networkidle');
    assert.equal(state.signups.length,2,'429 produces no automatic signup retries');
    assert(await page.locator('#accountSubmit').isEnabled());assert.equal(await page.locator('#accountSubmit').innerText(),'Create account');
    assert.match(await page.locator('#accountStatus').innerText(),/account may already exist/);
    // INITIAL_SESSION/auth refreshes must not erase the callback explanation.
    await page.goto(`${production}/?test_callback=expired#error=access_denied&error_code=otp_expired&error_description=%3Cimg%20src=x%3E`,{waitUntil:'networkidle'});
    await status(page,'expired or already been used');assert.equal(await page.locator('#accountStatus img').count(),0);
    assert.equal(new URL(page.url()).hash,'');assert(await page.locator('#accountDialog').evaluate(dialog=>dialog.open));
    await page.goto(`${production}/?error=access_denied`,{waitUntil:'networkidle'});await status(page,'cancelled');
    await page.locator('#accountDialogClose').click();await openSignup(page);state.signupError=null;
    await page.locator('#accountSubmit').click();await status(page,'Check your email');
    state.exchangeError={code:'flow_state_expired',msg:'Untrusted exchange error'};
    await page.goto(`${production}/?code=expired-flow`,{waitUntil:'networkidle'});await status(page,'Could not sign you in from this link');
    assert.equal(await page.evaluate(()=>currentUser),null);state.exchangeError=null;
    await page.locator('#accountReset').click();await page.locator('#accountEmail').fill(user.email);await page.locator('#accountSubmit').click();await status(page,'If this email');
    await page.goto(`${production}/?code=synthetic-recovery-code&recovery=1`,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>document.getElementById('accountDialogTitle').textContent==='Choose a new password');
    await page.locator('#accountPassword').fill('Synthetic-new-password');await page.locator('#accountSubmit').click();await page.waitForFunction(()=>!cleanMapAuthBusy&&cleanMapAccountMode==='signin');
    assert.equal(state.passwordUpdates.length,1);assert.equal(state.passwordUpdates[0].password,'Synthetic-new-password');assert.equal(await page.locator('#accountPassword').inputValue(),'');
    assert.equal(await page.locator('#accountSubmit').innerText(),'Sign in');
    assert.deepEqual(state.errors,[]);
    console.log(`PASS ${origin}: official SDK canonical signup, duplicate guard/loading, PKCE/session or cross-origin guidance, login/errors, 429/no retry, expired/cancelled callbacks, recovery; no page errors`);
   } finally {await context.close();}
  }
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
