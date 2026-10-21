-- ONLY after security-regression.sql in the disposable migration test database.
-- The fixture's existing feedback read policy intentionally allows all members.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
insert into public.feedback(id,report_id,user_id,message) values
 ('20000000-0000-0000-0000-000000000099','10000000-0000-0000-0000-000000000001',auth.uid(),'Shared member feedback');
insert into storage.objects(bucket_id,name) values('cleanmap-media','00000000-0000-0000-0000-000000000001/private-photo.jpg');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
select public.test_assert((select message='Shared member feedback' from public.feedback where id='20000000-0000-0000-0000-000000000099'),'Other authenticated users can read report feedback');
insert into public.feedback(id,report_id,user_id,message) values
 ('20000000-0000-0000-0000-000000000098','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Identity check');
select public.test_assert((select user_id=auth.uid() from public.feedback where id='20000000-0000-0000-0000-000000000098'),'Existing server guard keeps feedback identity tied to caller');
update public.feedback set message='Unauthorized edit' where id='20000000-0000-0000-0000-000000000099';
select public.test_assert((select message='Shared member feedback' from public.feedback where id='20000000-0000-0000-0000-000000000099'),'Reading feedback does not permit editing another member');
select public.test_assert((select count(*)=0 from storage.objects where bucket_id='cleanmap-media'),'Another user cannot read private media metadata');
select public.test_expect_denied('insert into storage.objects(bucket_id,name) values(''cleanmap-media'',''00000000-0000-0000-0000-000000000001/forged.jpg'')');
delete from storage.objects where bucket_id='cleanmap-media';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.test_assert((select count(*)=1 from storage.objects where bucket_id='cleanmap-media'),'Private media preserved with existing ownership');
reset role;

-- Provider metadata cannot set an administrator role through the initializer.
insert into auth.users(id,raw_user_meta_data) values
 ('00000000-0000-0000-0000-000000000094','{"display_name":"Fourth fixture","role":"admin"}');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000094',false);
select public.cleanmap_ensure_profile();select public.cleanmap_ensure_profile();
select public.test_assert((select role='member' from public.profiles where id=auth.uid()),'Provider metadata does not grant admin');
select public.cleanmap_save_profile('fourth_member','Fourth fixture','Public bio','Cebu City','Lahug',null);
select public.test_assert((select username='fourth_member' from public.cleanmap_public_profiles where id=auth.uid()),'Own profile RPC works');
select public.test_expect_denied('update public.profiles set role=''admin'' where id=auth.uid()');
select public.test_assert((select count(*)=1 from public.cleanmap_public_profiles where id=auth.uid()),'Repeated initialization is idempotent');
reset role;

-- Even an unsafe default must not make the new initializer create an administrator.
insert into auth.users(id) values('00000000-0000-0000-0000-000000000095');
alter table public.profiles alter role set default 'admin';
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000095',false);
select public.test_expect_denied('select public.cleanmap_ensure_profile()');
reset role;
select public.test_assert(not exists(select 1 from public.profiles where id='00000000-0000-0000-0000-000000000095'),'Unsafe default insert rolled back');
alter table public.profiles alter role set default 'member';

insert into public.reports(id,reporter_id,location,severity,city,barangay) values
 ('10000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000001','Restricted fixture location','low','Restricted fixture city','Restricted fixture barangay');
create policy fixture_area_privacy on public.reports as restrictive for select to authenticated
 using(city is distinct from 'Restricted fixture city');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select public.test_assert(not exists(select 1 from public.cleanmap_report_areas() where city='Restricted fixture city'),'Area RPC respects existing report visibility');
select public.test_assert(not exists(select 1 from public.cleanmap_report_directory where location='Restricted fixture location'),'Directory respects report visibility');
select public.test_assert((public.cleanmap_report_statistics()->>'total')::integer=(select count(*) from public.reports),'Statistics use only caller-visible reports');
reset role;
set role anon;
select public.test_assert(exists(select 1 from public.cleanmap_public_profiles where display_name='Fourth fixture'),'Only intended public identity projection available');
select public.test_expect_denied('select email from public.profiles');
select public.test_expect_denied('select * from public.cleanmap_report_directory');
select public.test_expect_denied('select public.cleanmap_report_areas()');
select public.test_expect_denied('select public.cleanmap_report_statistics()');
select public.test_expect_denied('select public.cleanmap_ensure_profile()');
select public.test_expect_denied('select public.cleanmap_save_profile(''attacker'',''Name'','''','''','''',null)');
reset role;
select public.test_assert((select not public from storage.buckets where id='cleanmap-media'),'Media bucket remains private');
select 'PASS repaired API security, authenticated feedback visibility, and private-media preservation';
