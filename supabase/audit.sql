-- Read-only audit. Run in Supabase SQL Editor; export results without user rows.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns where table_schema = 'public'
  and table_name in ('profiles','reports','feedback','report_votes')
order by table_name, ordinal_position;
select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('profiles','reports','feedback','report_votes');
select schemaname, tablename, policyname, roles, cmd, permissive, qual, with_check
from pg_policies where schemaname in ('public','storage') order by tablename, policyname;
select grantee, table_name, privilege_type from information_schema.role_table_grants
where table_schema in ('public','storage') and grantee in ('anon','authenticated');
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid)
from pg_constraint where conrelid in ('public.profiles'::regclass,'public.reports'::regclass,
'public.feedback'::regclass,'public.report_votes'::regclass);
select tgrelid::regclass, tgname, pg_get_triggerdef(oid) from pg_trigger
where not tgisinternal and tgrelid in ('auth.users'::regclass,'public.profiles'::regclass,
'public.reports'::regclass,'public.feedback'::regclass,'public.report_votes'::regclass);
select p.oid::regprocedure, pg_get_functiondef(p.oid) from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and (p.proname='is_admin' or p.proname like 'cleanmap_%');
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;
