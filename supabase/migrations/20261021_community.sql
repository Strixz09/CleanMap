-- Review supabase/audit.sql first. PostgreSQL 15+ (security_invoker views).
-- Atomic: incompatible schemas or existing data cause rollback, never record deletion.
-- Does NOT grant anonymous access to reports, feedback, votes or private media.
begin;
do $$
declare t text; c text; required record;
begin
  foreach t in array array['profiles','reports','feedback','report_votes'] loop
    if to_regclass('public.'||t) is null then raise exception 'Missing required table: %',t; end if;
    if not (select relrowsecurity from pg_class where oid=to_regclass('public.'||t)) then
      raise exception 'Audit and enable existing RLS before migrating: %',t;
    end if;
  end loop;
  if to_regprocedure('public.is_admin()') is null then raise exception 'Audit required: missing public.is_admin()'; end if;
  if (select data_type from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='id') <> 'uuid' then
    raise exception 'profiles.id must reference auth.users UUID';
  end if;
  for required in select column_name from information_schema.columns where table_schema='public'
    and table_name='profiles' and is_nullable='NO' and column_default is null
    and column_name not in ('id','display_name') loop
    raise exception 'Profile initializer requires schema-specific handling for mandatory column %',required.column_name;
  end loop;
end $$;

alter table public.profiles add column if not exists username text,
  add column if not exists display_name text,
  add column if not exists bio text,
  add column if not exists avatar_url text,
  add column if not exists city text,
  add column if not exists barangay text,
  add column if not exists created_at timestamptz default now();
create unique index if not exists cleanmap_username_unique on public.profiles(lower(username)) where username is not null;
alter table public.profiles add constraint cleanmap_profile_fields check (
  (username is null or username ~ '^[a-z0-9_]{3,30}$') and
  char_length(coalesce(display_name,'')) <= 60 and char_length(coalesce(bio,'')) <= 280 and
  char_length(coalesce(city,'')) <= 100 and char_length(coalesce(barangay,'')) <= 100 and
  (avatar_url is null or (char_length(avatar_url)<=2048 and avatar_url ~ '^https://'))
);
alter table public.reports add column if not exists city text, add column if not exists barangay text;
alter table public.reports add constraint cleanmap_report_area_lengths check
  (char_length(coalesce(city,''))<=100 and char_length(coalesce(barangay,''))<=100 and (barangay is null or nullif(btrim(city),'') is not null));

-- Safe public projection; never select email, role or arbitrary metadata here.
create view public.cleanmap_public_profiles with (security_barrier=true) as
select p.id, p.username, p.display_name, p.bio, p.avatar_url, p.city, p.barangay, u.created_at as created_at
from public.profiles p join auth.users u on u.id=p.id;
revoke all on public.cleanmap_public_profiles from public;
grant select on public.cleanmap_public_profiles to anon, authenticated;
-- Private profile table: clients can only read their own role and ID.
revoke select, insert, update, delete on public.profiles from public, anon, authenticated;
do $$ declare c record; begin
  for c in select attname from pg_attribute where attrelid='public.profiles'::regclass and attnum>0 and not attisdropped loop
    execute format('revoke select (%I), insert (%I), update (%I), references (%I) on public.profiles from public,anon,authenticated',c.attname,c.attname,c.attname,c.attname);
  end loop;
end $$;
grant select(id,role) on public.profiles to authenticated;
create policy cleanmap_private_profile_read on public.profiles as restrictive for select to authenticated using (id=(select auth.uid()));

-- Uses authenticated identity, never a supplied profile ID or role.
create function public.cleanmap_ensure_profile() returns void
language plpgsql security definer set search_path='' as $$
declare u auth.users; avatar text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  select * into strict u from auth.users where id=auth.uid();
  avatar := coalesce(u.raw_user_meta_data->>'avatar_url',u.raw_user_meta_data->>'picture');
  if avatar !~ '^https://' or char_length(avatar)>2048 then avatar:=null; end if;
  insert into public.profiles(id,display_name,avatar_url,created_at)
    values(u.id,left(coalesce(u.raw_user_meta_data->>'display_name',u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name','Community member'),60),avatar,u.created_at)
  on conflict(id) do nothing;
end $$;
create function public.cleanmap_save_profile(p_username text,p_display_name text,p_bio text,p_city text,p_barangay text,p_avatar_url text)
returns void language plpgsql security definer set search_path='' as $$
declare old_avatar text; expected_prefix text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  perform public.cleanmap_ensure_profile();
  select avatar_url into old_avatar from public.profiles where id=auth.uid() for update;
  expected_prefix := 'https://zezcbpmmhpwzlbuafsby.supabase.co/storage/v1/object/public/cleanmap-avatars/'||auth.uid()::text||'/';
  if p_avatar_url is distinct from old_avatar and p_avatar_url is not null
    and (left(p_avatar_url,length(expected_prefix))<>expected_prefix or
      substring(p_avatar_url from length(expected_prefix)+1) !~ '^[a-f0-9-]+\.jpg$') then
    raise exception 'Use your own uploaded avatar' using errcode='42501';
  end if;
  if nullif(btrim(p_display_name),'') is null or nullif(btrim(p_username),'') is null then raise exception 'Username and display name are required'; end if;
  update public.profiles set username=lower(btrim(p_username)),display_name=btrim(p_display_name),
    bio=nullif(btrim(p_bio),''),city=nullif(btrim(p_city),''),barangay=nullif(btrim(p_barangay),''),avatar_url=p_avatar_url
    where id=auth.uid();
end $$;
revoke all on function public.cleanmap_ensure_profile(), public.cleanmap_save_profile(text,text,text,text,text,text) from public,anon;
grant execute on function public.cleanmap_ensure_profile(), public.cleanmap_save_profile(text,text,text,text,text,text) to authenticated;

-- Restrictive checks also constrain any pre-existing permissive write policies.
create policy cleanmap_report_insert_identity on public.reports as restrictive for insert to authenticated with check (reporter_id=(select auth.uid()));
create policy cleanmap_report_update_owner on public.reports as restrictive for update to authenticated using (reporter_id=(select auth.uid()) or coalesce(public.is_admin(),false)) with check (reporter_id=(select auth.uid()) or coalesce(public.is_admin(),false));
create policy cleanmap_report_delete_owner on public.reports as restrictive for delete to authenticated using (reporter_id=(select auth.uid()) or coalesce(public.is_admin(),false));
create policy cleanmap_feedback_insert_identity on public.feedback as restrictive for insert to authenticated with check (user_id=(select auth.uid()));
create policy cleanmap_feedback_update_owner on public.feedback as restrictive for update to authenticated using (user_id=(select auth.uid()) or coalesce(public.is_admin(),false)) with check (user_id=(select auth.uid()) or coalesce(public.is_admin(),false));
create policy cleanmap_feedback_delete_owner on public.feedback as restrictive for delete to authenticated using (user_id=(select auth.uid()) or coalesce(public.is_admin(),false));
create policy cleanmap_vote_insert_identity on public.report_votes as restrictive for insert to authenticated with check (user_id=(select auth.uid()));
create policy cleanmap_vote_update_owner on public.report_votes as restrictive for update to authenticated using (user_id=(select auth.uid())) with check (user_id=(select auth.uid()));
create policy cleanmap_vote_delete_owner on public.report_votes as restrictive for delete to authenticated using (user_id=(select auth.uid()));
-- Enforce future relationships without attributing or deleting legacy orphan rows.
alter table public.profiles add constraint cleanmap_profile_user_fk foreign key(id) references auth.users(id) not valid;
alter table public.reports add constraint cleanmap_report_user_fk foreign key(reporter_id) references auth.users(id) not valid;
alter table public.feedback add constraint cleanmap_feedback_user_fk foreign key(user_id) references auth.users(id) not valid;
alter table public.feedback add constraint cleanmap_feedback_report_fk foreign key(report_id) references public.reports(id) not valid;
alter table public.report_votes add constraint cleanmap_vote_user_fk foreign key(user_id) references auth.users(id) not valid;
alter table public.report_votes add constraint cleanmap_vote_report_fk foreign key(report_id) references public.reports(id) not valid;
alter table public.feedback add constraint cleanmap_feedback_length check(char_length(btrim(message)) between 1 and 280) not valid;
create unique index if not exists cleanmap_one_vote_per_user on public.report_votes(report_id,user_id);
revoke insert,update,delete on public.reports,public.feedback,public.report_votes from anon;

create function public.cleanmap_guard_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if current_user not in ('anon','authenticated') then return new; end if;
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  if tg_table_name='reports' then
    if tg_op='INSERT' then
      new.reporter_id:=auth.uid();
      new.verification_status:='Pending verification';
    elsif new.reporter_id is distinct from old.reporter_id then
      raise exception 'Report author cannot be changed' using errcode='42501';
    elsif new.verification_status is distinct from old.verification_status and not coalesce(public.is_admin(),false) then
      raise exception 'Administrator access required' using errcode='42501';
    end if;
  else
    if tg_op='INSERT' then new.user_id:=auth.uid();
    elsif new.user_id is distinct from old.user_id or new.report_id is distinct from old.report_id then
      raise exception 'Content ownership cannot be changed' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger cleanmap_identity before insert or update on public.reports for each row execute function public.cleanmap_guard_identity();
create trigger cleanmap_identity before insert or update on public.feedback for each row execute function public.cleanmap_guard_identity();
create trigger cleanmap_identity before insert or update on public.report_votes for each row execute function public.cleanmap_guard_identity();

-- Public avatar files are intentionally public; only the owning UUID may write.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('cleanmap-avatars','cleanmap-avatars',true,2097152,array['image/jpeg']) on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='cleanmap-avatars' and public and file_size_limit=2097152 and allowed_mime_types=array['image/jpeg']) then
  raise exception 'Existing cleanmap-avatars bucket differs; audit it before migrating';
 end if;
end $$;
create policy cleanmap_avatar_read on storage.objects for select to anon,authenticated using(bucket_id='cleanmap-avatars');
create policy cleanmap_avatar_insert on storage.objects for insert to authenticated with check(bucket_id='cleanmap-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy cleanmap_avatar_update on storage.objects for update to authenticated using(bucket_id='cleanmap-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text) with check(bucket_id='cleanmap-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy cleanmap_avatar_delete on storage.objects for delete to authenticated using(bucket_id='cleanmap-avatars' and (storage.foldername(name))[1]=(select auth.uid())::text);
-- Restrict old broad policies for the new bucket, without altering existing media access.
create policy cleanmap_avatar_insert_guard on storage.objects as restrictive for insert to anon,authenticated with check(bucket_id<>'cleanmap-avatars' or (auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text));
create policy cleanmap_avatar_update_guard on storage.objects as restrictive for update to anon,authenticated using(bucket_id<>'cleanmap-avatars' or (auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text)) with check(bucket_id<>'cleanmap-avatars' or (auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text));
create policy cleanmap_avatar_delete_guard on storage.objects as restrictive for delete to anon,authenticated using(bucket_id<>'cleanmap-avatars' or (auth.uid() is not null and (storage.foldername(name))[1]=auth.uid()::text));

-- All report/feedback/vote reads execute with the caller's existing RLS policies.
create view public.cleanmap_report_directory with (security_invoker=true) as
select r.id,r.reporter_id,r.location,r.pollution_type,r.severity as reporter_severity,
 case when v.total>=3 and v.top_count::numeric/v.total>=0.60 then v.top_severity else r.severity end as severity,
 r.description,r.latitude,r.longitude,r.photo_url,r.video_url,r.created_at,r.verification_status,r.city,r.barangay,
 coalesce(v.vote_counts,'{"low":0,"moderate":0,"high":0,"severe":0}'::jsonb) as vote_counts,
 coalesce(v.total,0) + (select count(*) from public.feedback f where f.report_id=r.id) as activity_count,
 case (case when v.total>=3 and v.top_count::numeric/v.total>=0.60 then v.top_severity else r.severity end)
   when 'severe' then 4 when 'high' then 3 when 'moderate' then 2 else 1 end as severity_rank
from public.reports r left join lateral (
 select jsonb_object_agg(c.severity,c.n) as vote_counts,sum(c.n) as total,
  (array_agg(c.severity order by c.n desc,array_position(array['low','moderate','high','severe'],c.severity)))[1] as top_severity,
  max(c.n) as top_count
 from (select severity,count(*) as n from public.report_votes where report_id=r.id and severity in ('low','moderate','high','severe') group by severity) c
) v on true;
grant select on public.cleanmap_report_directory to authenticated;
create function public.cleanmap_report_areas() returns table(city text,barangay text)
language sql stable security invoker set search_path='' as $$
 select distinct r.city,r.barangay from public.reports r where nullif(btrim(r.city),'') is not null order by r.city,r.barangay;
$$;
create function public.cleanmap_report_statistics() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('total',count(*),'low',count(*) filter(where severity='low'),
 'moderate',count(*) filter(where severity='moderate'),'high',count(*) filter(where severity='high'),
 'severe',count(*) filter(where severity='severe'),'areas',count(distinct location)) from public.cleanmap_report_directory;
$$;
revoke all on function public.cleanmap_report_areas(),public.cleanmap_report_statistics() from public,anon;
grant execute on function public.cleanmap_report_areas(),public.cleanmap_report_statistics() to authenticated;
create index if not exists cleanmap_report_created on public.reports(created_at desc,id);
create index if not exists cleanmap_report_author on public.reports(reporter_id,created_at desc);
create index if not exists cleanmap_report_area on public.reports(city,barangay);
create index if not exists cleanmap_feedback_report on public.feedback(report_id,created_at desc);
create index if not exists cleanmap_feedback_author on public.feedback(user_id,created_at desc);
notify pgrst,'reload schema';
commit;
