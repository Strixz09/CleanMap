-- ONLY for a fresh disposable PostgreSQL database. Never run on Supabase production.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create schema storage;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth,storage,public to anon,authenticated;
create table auth.users(id uuid primary key,created_at timestamptz default now(),raw_user_meta_data jsonb default '{}');
create table public.profiles(id uuid primary key references auth.users(id),role text not null default 'member',email text,display_name text);
create table public.reports(id uuid primary key default gen_random_uuid(),reporter_id uuid references auth.users(id),location text,pollution_type text,severity text,description text,latitude numeric,longitude numeric,photo_url text,video_url text,created_at timestamptz default now(),verification_status text default 'Pending verification');
create table public.feedback(id uuid primary key default gen_random_uuid(),report_id uuid references public.reports(id) on delete cascade,user_id uuid references auth.users(id),message text,created_at timestamptz default now());
create table public.report_votes(id uuid primary key default gen_random_uuid(),report_id uuid references public.reports(id) on delete cascade,user_id uuid references auth.users(id),severity text);
create function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$select coalesce((select role='admin' from public.profiles where id=auth.uid()),false)$$;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
do $$declare t text;begin
 foreach t in array array['profiles','reports','feedback','report_votes'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('create policy baseline on public.%I for all to authenticated using(true) with check(true)',t);
 execute format('grant all on public.%I to authenticated',t);
 end loop;
end$$;
alter table storage.objects enable row level security;
create policy old_broad_storage on storage.objects for all to authenticated using(true) with check(true);
grant all on storage.objects to authenticated;
-- Synthetic identities exist only in this disposable database.
insert into auth.users(id,raw_user_meta_data) values
('00000000-0000-0000-0000-000000000001','{"full_name":"Fixture member","avatar_url":"https://example.org/avatar.jpg"}'),
('00000000-0000-0000-0000-000000000002','{"full_name":"Second fixture"}'),
('00000000-0000-0000-0000-000000000003','{"full_name":"Fixture admin"}');
insert into public.profiles(id,role,email,display_name) values
('00000000-0000-0000-0000-000000000001','member','private@example.invalid','Existing name'),
('00000000-0000-0000-0000-000000000003','admin','admin@example.invalid','Admin');
