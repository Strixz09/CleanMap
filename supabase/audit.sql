-- Read-only: run the whole file in Supabase SQL Editor as the project owner.
-- Returns ONE JSON cell to export/share. No account/report/media rows are read.
-- Includes database function bodies; review for embedded secrets before sharing.
-- Missing application relations/functions are reported instead of causing regclass errors.
with expected_relations(name) as (values
  ('public.profiles'), ('public.reports'), ('public.feedback'), ('public.report_votes'),
  ('public.cleanmap_public_profiles'), ('public.cleanmap_report_directory'),
  ('auth.users'), ('storage.buckets'), ('storage.objects'),
  ('supabase_migrations.schema_migrations')
), relations as (
  select e.name, c.*, n.nspname from expected_relations e
  left join pg_class c on c.oid=to_regclass(e.name)
  left join pg_namespace n on n.oid=c.relnamespace
), client_roles as (
  select oid,rolname from pg_roles where rolname in ('anon','authenticated','authenticator')
), relevant_triggers as (
  select t.* from pg_trigger t join relations r on r.oid=t.tgrelid
  where not t.tgisinternal
), routines as (
  select p.*, n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.prokind in ('f','p') and (
    (n.nspname='public' and (p.proname='is_admin' or p.proname like 'cleanmap\_%' escape '\'))
    or (n.nspname='auth' and p.proname='uid')
    or p.oid in (select tgfoid from relevant_triggers)
  )
)
select jsonb_pretty(jsonb_build_object(
  'server_version',current_setting('server_version'),
  'database',current_database(),
  'executed_as',current_user,
  'client_roles',(select coalesce(jsonb_agg(rolname order by rolname),'[]'::jsonb) from client_roles),
  'relations',(select jsonb_agg(jsonb_build_object(
    'name',name,'exists',oid is not null,'kind',relkind,'owner',pg_get_userbyid(relowner),
    'rls',relrowsecurity,'force_rls',relforcerowsecurity,'options',reloptions,
    'view_definition',case when relkind in ('v','m') then pg_get_viewdef(oid,true) end
  ) order by name) from relations),
  'columns',(select coalesce(jsonb_agg(jsonb_build_object(
    'relation',r.name,'name',a.attname,'position',a.attnum,
    'type',format_type(a.atttypid,a.atttypmod),'type_schema',tn.nspname,'type_name',t.typname,
    'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
    'default',pg_get_expr(d.adbin,d.adrelid)
  ) order by r.name,a.attnum),'[]'::jsonb)
    from relations r join pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped
    join pg_type t on t.oid=a.atttypid join pg_namespace tn on tn.oid=t.typnamespace
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum),
  'enum_values',(select coalesce(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'type',t.typname,'label',e.enumlabel,'order',e.enumsortorder
  ) order by n.nspname,t.typname,e.enumsortorder),'[]'::jsonb)
    from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
    where t.oid in (select a.atttypid from pg_attribute a join relations r on r.oid=a.attrelid)),
  'constraints',(select coalesce(jsonb_agg(jsonb_build_object(
    'relation',r.name,'name',c.conname,'validated',c.convalidated,'definition',pg_get_constraintdef(c.oid,true)
  ) order by r.name,c.conname),'[]'::jsonb) from pg_constraint c join relations r on r.oid=c.conrelid),
  'indexes',(select coalesce(jsonb_agg(jsonb_build_object(
    'relation',r.name,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid
  ) order by r.name,i.indexrelid),'[]'::jsonb) from pg_index i join relations r on r.oid=i.indrelid),
  'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.schemaname,p.tablename,p.policyname),'[]'::jsonb)
    from pg_policies p where p.schemaname in ('public','storage')
    and (p.schemaname||'.'||p.tablename) in (select name from relations)),
  'table_access',(select coalesce(jsonb_agg(jsonb_build_object(
    'relation',r.name,'role',cr.rolname,
    'select',has_table_privilege(cr.oid,r.oid,'SELECT'),
    'insert',has_table_privilege(cr.oid,r.oid,'INSERT'),
    'update',has_table_privilege(cr.oid,r.oid,'UPDATE'),
    'delete',has_table_privilege(cr.oid,r.oid,'DELETE')
  ) order by r.name,cr.rolname),'[]'::jsonb) from relations r cross join client_roles cr where r.oid is not null),
  'explicit_column_grants',(select coalesce(jsonb_agg(jsonb_build_object(
    'relation',r.name,'column',a.attname,'grantee',case when acl.grantee=0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    'privilege',acl.privilege_type,'grantable',acl.is_grantable
  ) order by r.name,a.attnum,acl.grantee,acl.privilege_type),'[]'::jsonb)
    from relations r join pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped
    cross join lateral aclexplode(a.attacl) acl),
  'triggers',(select coalesce(jsonb_agg(jsonb_build_object(
    'relation',t.tgrelid::regclass::text,'name',t.tgname,'enabled',t.tgenabled,
    'definition',pg_get_triggerdef(t.oid,true)
  ) order by t.tgrelid,t.tgname),'[]'::jsonb) from relevant_triggers t),
  'routines',(select coalesce(jsonb_agg(jsonb_build_object(
    'signature',p.oid::regprocedure::text,'schema',p.nspname,'name',p.proname,
    'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid),
    'owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'volatility',p.provolatile,
    'definition',pg_get_functiondef(p.oid),
    'execute_by',(select coalesce(jsonb_agg(cr.rolname order by cr.rolname),'[]'::jsonb)
      from client_roles cr where has_function_privilege(cr.oid,p.oid,'EXECUTE'))
  ) order by p.nspname,p.proname,p.oid),'[]'::jsonb) from routines p),
  'expected_routines',(select jsonb_agg(jsonb_build_object('signature',signature,'exists',to_regprocedure(signature) is not null))
    from (values ('public.is_admin()'),('public.cleanmap_ensure_profile()'),
      ('public.cleanmap_save_profile(text,text,text,text,text,text)'),
      ('public.cleanmap_report_areas()'),('public.cleanmap_report_statistics()')) f(signature)),
  'schema_usage',(select coalesce(jsonb_agg(jsonb_build_object(
    'schema',n.nspname,'role',cr.rolname,'usage',has_schema_privilege(cr.oid,n.oid,'USAGE')
  ) order by n.nspname,cr.rolname),'[]'::jsonb)
    from pg_namespace n cross join client_roles cr where n.nspname in ('public','auth','storage')),
  'postgrest_database_settings',(select coalesce(jsonb_agg(jsonb_build_object(
    'database',case when s.setdatabase=0 then 'all' else d.datname end,
    'role',case when s.setrole=0 then 'all' else pg_get_userbyid(s.setrole) end,'setting',setting
  ) order by s.setdatabase,s.setrole,setting),'[]'::jsonb)
    from pg_db_role_setting s left join pg_database d on d.oid=s.setdatabase
    cross join lateral unnest(s.setconfig) setting
    where split_part(setting,'=',1) in ('pgrst.db_schemas','pgrst.db_extra_search_path')),
  'postgrest_note','Empty settings do not prove public is unexposed: also check Dashboard Data API exposed schemas. SQL Editor cannot directly inspect the running PostgREST cache.',
  'migration_history_note','The history relation is inventoried above. SQL Editor migrations may not be recorded in Supabase CLI history; share the original migration error if one occurred.'
)) as cleanmap_schema_audit;

-- Bucket privacy/limits are settings, not uploaded objects. Run this separately
-- only after the audit confirms storage.buckets exists, and share its result too:
-- select id,name,public,file_size_limit,allowed_mime_types from storage.buckets
-- where id in ('cleanmap-media','cleanmap-avatars');
