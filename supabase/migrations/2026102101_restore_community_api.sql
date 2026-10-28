-- REVIEW REQUIRED: the full live audit JSON has not reached this workspace.
-- Guarded draft for project zezcbpmmhpwzlbuafsby; compare audit before execution.
-- Creates only the six missing API objects. No base-table, policy, trigger,
-- Storage, account/data, or migration-history changes. Run manually in SQL Editor.
-- Compatible existing objects are preserved; conflicting definitions abort.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = '';
-- Serialize repeated/concurrent execution of this same repair.
select pg_catalog.pg_advisory_xact_lock(20261021, 1);

do $preflight$
declare item record; col text; missing text; a record;
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'PostgreSQL 15+ is required for RLS-preserving invoker views';
  end if;
  if current_user in ('anon','authenticated','authenticator') then
    raise exception 'Run this reviewed migration as the database owner in SQL Editor';
  end if;
  if to_regrole('anon') is null or to_regrole('authenticated') is null
    or to_regprocedure('auth.uid()') is null then
    raise exception 'Supabase Auth roles/auth.uid() are required';
  end if;
  for item in select * from (values
    ('public.profiles',array['id','role','username','display_name','bio','avatar_url','city','barangay','created_at']),
    ('public.reports',array['id','reporter_id','location','pollution_type','severity','description','latitude','longitude','photo_url','video_url','created_at','verification_status','city','barangay']),
    ('public.feedback',array['id','report_id','user_id','message','created_at']),
    ('public.report_votes',array['id','report_id','user_id','severity']),
    ('auth.users',array['id','created_at','raw_user_meta_data'])
  ) required(relation_name,columns) loop
    if not exists(select 1 from pg_class where oid=to_regclass(item.relation_name) and relkind in ('r','p')) then
      raise exception 'Required base table missing: %. Review audit; this repair does not create it.',item.relation_name;
    end if;
    select string_agg(c,', ' order by c) into missing from unnest(item.columns) c
      where not exists(select 1 from pg_attribute where attrelid=to_regclass(item.relation_name) and attname=c and attnum>0 and not attisdropped);
    if missing is not null then
      raise exception 'Missing columns on %: %. Review audit; no columns were added.',item.relation_name,missing;
    end if;
    if item.relation_name like 'public.%' and not (select relrowsecurity from pg_class where oid=to_regclass(item.relation_name)) then
      raise exception 'Existing RLS must be audited/enabled on %; this repair does not change policies.',item.relation_name;
    end if;
  end loop;
  if (select atttypid from pg_attribute where attrelid='public.profiles'::regclass and attname='id') <> 'uuid'::regtype then
    raise exception 'profiles.id must match the Supabase user UUID; inspect actual schema';
  end if;
  foreach col in array array['username','display_name','bio','avatar_url','city','barangay'] loop
    if (select atttypid from pg_attribute where attrelid='public.profiles'::regclass and attname=col) not in ('text'::regtype,'varchar'::regtype) then
      raise exception 'Unsupported public profile field type: %. Adapt to the actual audit first.',col;
    end if;
  end loop;
  for a in select attname from pg_attribute where attrelid='public.profiles'::regclass
    and attnum>0 and not attisdropped and attnotnull and not atthasdef
    and attidentity='' and attgenerated='' and attname not in ('id','display_name','avatar_url','created_at') loop
    raise exception 'Profile initialization requires audited handling of mandatory field: %',a.attname;
  end loop;
  if exists(select 1 from pg_attribute where attrelid='public.profiles'::regclass and attname in ('id','username','display_name','bio','avatar_url','city','barangay','created_at') and (attgenerated<>'' or attidentity<>'')) then
    raise exception 'Generated/identity profile fields require schema-specific review';
  end if;
  if not exists(select 1 from pg_index i where i.indrelid='public.profiles'::regclass
    and i.indisunique and i.indisvalid and i.indisready and i.indnkeyatts=1 and i.indpred is null
    and i.indexprs is null and i.indkey[0]=(select attnum from pg_attribute where attrelid=i.indrelid and attname='id')) then
    raise exception 'profiles.id requires an existing unique key for safe initialization';
  end if;
  -- Do not create an index blindly over existing usernames. Require the established
  -- case-insensitive uniqueness guarantee; otherwise stop for data/schema review.
  if not exists(select 1 from pg_index i where i.indrelid='public.profiles'::regclass
    and i.indisunique and i.indisvalid and i.indisready and i.indnkeyatts=1
    and regexp_replace(pg_get_indexdef(i.indexrelid,1,true),'::text|[[:space:]()]','','g')='lowerusername'
    and (i.indpred is null or regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')='usernameISNOTNULL')) then
    raise exception 'An existing unique index on lower(profiles.username) is required; review audit and existing values before adding one';
  end if;
end $preflight$;

-- Compare parsed definitions on rerun; never silently replace an unrelated view.
do $views$
declare spec record; existing oid; expected oid; temp_name text; options text[];
begin
  for spec in select * from (values
    ('cleanmap_public_profiles','security_barrier=true, security_invoker=false',array['security_barrier=true','security_invoker=false'],true,
     $query$select p.id,p.username,p.display_name,p.bio,p.avatar_url,p.city,p.barangay,u.created_at
       from public.profiles p join auth.users u on u.id=p.id$query$),
    ('cleanmap_report_directory','security_invoker=true',array['security_invoker=true'],false,
     $query$select r.id,r.reporter_id,r.location,r.pollution_type,r.severity::text as reporter_severity,
       case when v.total>=3 and v.top_count::numeric/v.total>=0.60 then v.top_severity else r.severity::text end as severity,
       r.description,r.latitude,r.longitude,r.photo_url,r.video_url,r.created_at,r.verification_status,r.city,r.barangay,
       coalesce(v.vote_counts,'{"low":0,"moderate":0,"high":0,"severe":0}'::jsonb) as vote_counts,
       coalesce(v.total,0)+(select count(*) from public.feedback f where f.report_id=r.id) as activity_count,
       case (case when v.total>=3 and v.top_count::numeric/v.total>=0.60 then v.top_severity else r.severity::text end)
         when 'severe' then 4 when 'high' then 3 when 'moderate' then 2 else 1 end as severity_rank
       from public.reports r left join lateral (
         select jsonb_object_agg(c.severity,c.n) as vote_counts,sum(c.n) as total,
           (array_agg(c.severity order by c.n desc,array_position(array['low','moderate','high','severe'],c.severity)))[1] as top_severity,
           max(c.n) as top_count
         from (select severity::text as severity,count(*) as n from public.report_votes
           where report_id=r.id and severity::text in ('low','moderate','high','severe') group by severity::text) c
       ) v on true$query$)
  ) definitions(name,settings,required_options,public_read,query) loop
    existing:=to_regclass('public.'||spec.name);
    if existing is null then
      execute format('create view public.%I with (%s) as %s',spec.name,spec.settings,spec.query);
      execute format('revoke all on public.%I from public,anon,authenticated',spec.name);
      execute format('grant select on public.%I to authenticated',spec.name);
      if spec.public_read then execute format('grant select on public.%I to anon',spec.name); end if;
    else
      if not exists(select 1 from pg_class where oid=existing and relkind='v' and relowner=(select oid from pg_roles where rolname=current_user)) then
        raise exception 'Existing public.% has an unexpected object type or owner; review it first',spec.name;
      end if;
      temp_name:='cleanmap_check_'||pg_backend_pid()||'_'||spec.name;
      execute format('create temporary view %I as %s',temp_name,spec.query);
      expected:=to_regclass('pg_temp.'||temp_name);
      if pg_get_viewdef(existing,true) is distinct from pg_get_viewdef(expected,true) then
        raise exception 'Existing public.% differs from this repair; no existing definition was replaced',spec.name;
      end if;
      execute format('drop view pg_temp.%I',temp_name);
      select reloptions into options from pg_class where oid=existing;
      if not coalesce(options @> spec.required_options,false)
        or not has_table_privilege('authenticated',existing,'SELECT')
        or has_any_column_privilege('anon',existing,'SELECT') is distinct from spec.public_read
        or has_table_privilege('authenticated',existing,'INSERT,UPDATE,DELETE')
        or has_table_privilege('anon',existing,'INSERT,UPDATE,DELETE')
        or has_any_column_privilege('authenticated',existing,'INSERT,UPDATE')
        or has_any_column_privilege('anon',existing,'INSERT,UPDATE') then
        raise exception 'Existing public.% has different security options/grants; audit before changing them',spec.name;
      end if;
    end if;
  end loop;
end $views$;

-- Constant SQL definitions only. Named arguments exactly match community.js.
do $routines$
declare spec record; existing oid; routine record;
begin
  for spec in select * from (values
    ('cleanmap_ensure_profile','','','void','plpgsql',true,'v',
$body$
declare u auth.users; avatar text; inserted_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  if exists(select 1 from public.profiles where id=auth.uid()) then return; end if;
  select * into strict u from auth.users where id=auth.uid();
  avatar:=coalesce(u.raw_user_meta_data->>'avatar_url',u.raw_user_meta_data->>'picture');
  if avatar !~ '^https://' or char_length(avatar)>2048 then avatar:=null; end if;
  insert into public.profiles(id,display_name,avatar_url,created_at)
    values(u.id,left(coalesce(u.raw_user_meta_data->>'display_name',u.raw_user_meta_data->>'full_name',u.raw_user_meta_data->>'name','Community member'),60),avatar,u.created_at)
    on conflict(id) do nothing;
  get diagnostics inserted_count=row_count;
  if inserted_count>0 and exists(select 1 from public.profiles where id=u.id and role::text='admin') then
    raise exception 'Profile initialization must not assign administrator privileges; audit the existing default/trigger' using errcode='42501';
  end if;
end
$body$),
    ('cleanmap_save_profile','text,text,text,text,text,text','p_username text, p_display_name text, p_bio text, p_city text, p_barangay text, p_avatar_url text','void','plpgsql',true,'v',
$body$
declare old_avatar text; expected_prefix text; normalized_username text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  normalized_username:=lower(btrim(p_username));
  if normalized_username is null or normalized_username !~ '^[a-z0-9_]{3,30}$'
    or nullif(btrim(p_display_name),'') is null or char_length(btrim(p_display_name))>60
    or char_length(coalesce(btrim(p_bio),''))>280 or char_length(coalesce(btrim(p_city),''))>100
    or char_length(coalesce(btrim(p_barangay),''))>100 then
    raise exception 'Invalid public profile fields' using errcode='22023';
  end if;
  perform public.cleanmap_ensure_profile();
  select avatar_url into old_avatar from public.profiles where id=auth.uid() for update;
  expected_prefix:='https://zezcbpmmhpwzlbuafsby.supabase.co/storage/v1/object/public/cleanmap-avatars/'||auth.uid()::text||'/';
  if p_avatar_url is distinct from old_avatar and p_avatar_url is not null
    and (char_length(p_avatar_url)>2048 or left(p_avatar_url,length(expected_prefix))<>expected_prefix
      or substring(p_avatar_url from length(expected_prefix)+1) !~ '^[a-f0-9-]+\.jpg$') then
    raise exception 'Use your own uploaded avatar' using errcode='42501';
  end if;
  update public.profiles set username=normalized_username,display_name=btrim(p_display_name),
    bio=nullif(btrim(p_bio),''),city=nullif(btrim(p_city),''),barangay=nullif(btrim(p_barangay),''),avatar_url=p_avatar_url
    where id=auth.uid();
end
$body$),
    ('cleanmap_report_areas','','','TABLE(city text, barangay text)','sql',false,'s',
$body$
select distinct r.city::text,r.barangay::text from public.reports r
where nullif(btrim(r.city::text),'') is not null order by r.city::text,r.barangay::text;
$body$),
    ('cleanmap_report_statistics','','','jsonb','sql',false,'s',
$body$
select jsonb_build_object('total',count(*),'low',count(*) filter(where severity='low'),
  'moderate',count(*) filter(where severity='moderate'),'high',count(*) filter(where severity='high'),
  'severe',count(*) filter(where severity='severe'),'areas',count(distinct location))
from public.cleanmap_report_directory;
$body$)
  ) definitions(name,identity_args,named_args,result,language,definer,volatility,body) loop
    existing:=to_regprocedure(format('public.%I(%s)',spec.name,spec.identity_args));
    if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=spec.name and p.oid is distinct from existing) then
      raise exception 'Unexpected overload of public.%; audit RPC resolution before proceeding',spec.name;
    end if;
    if existing is null then
      execute format('create function public.%I(%s) returns %s language %I %s security %s set search_path='''' as %L',
        spec.name,spec.named_args,spec.result,spec.language,
        case when spec.volatility='s' then 'stable' else 'volatile' end,
        case when spec.definer then 'definer' else 'invoker' end,spec.body);
      execute format('revoke all on function public.%I(%s) from public,anon,authenticated',spec.name,spec.identity_args);
      execute format('grant execute on function public.%I(%s) to authenticated',spec.name,spec.identity_args);
    else
      select p.*,l.lanname into routine from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=existing;
      if routine.prosrc is distinct from spec.body or routine.prosecdef is distinct from spec.definer
        or routine.provolatile::text<>spec.volatility or routine.lanname<>spec.language
        or routine.proconfig is distinct from array['search_path=""']::text[]
        or routine.proowner<>(select oid from pg_roles where rolname=current_user)
        or pg_get_function_arguments(existing)<>spec.named_args
        or pg_get_function_result(existing)<>spec.result
        or has_function_privilege('anon',existing,'EXECUTE')
        or not has_function_privilege('authenticated',existing,'EXECUTE') then
        raise exception 'Existing public.% differs in definition/signature/security; no existing function was replaced',spec.name;
      end if;
    end if;
  end loop;
end $routines$;

-- Delivered only when the transaction commits. Does not create migration history.
notify pgrst, 'reload schema';
commit;
