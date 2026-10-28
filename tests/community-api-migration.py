"""Simulate the API repair in a disposable local PostgreSQL Docker container.
Never points at hosted Supabase. The fixture is NOT the missing live audit.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--docker-host', default='unix:///home/vercel-sandbox/runtime/cleanmap-docker/docker.sock')
parser.add_argument('--container', default='cleanmap-security-db')
parser.add_argument('--port', default='5433')
args = parser.parse_args()
if not args.docker_host.startswith('unix:///'):
    parser.error('Use a local Unix Docker socket and a disposable PostgreSQL container')
DB = 'cleanmap_api_repair_test'
CMD = ['docker', '-H', args.docker_host, 'exec', '-i', args.container,
       'psql', '-X', '-q', '-A', '-t', '-p', args.port, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1']
MIGRATION = (ROOT / 'supabase/migrations/2026102101_restore_community_api.sql').read_text()
DROP_API = '''
drop function public.cleanmap_report_statistics(),public.cleanmap_report_areas(),
 public.cleanmap_save_profile(text,text,text,text,text,text),public.cleanmap_ensure_profile();
drop view public.cleanmap_report_directory,public.cleanmap_public_profiles;
'''
BASELINE_SECURITY = '''
insert into storage.buckets values('cleanmap-media','cleanmap-media',false,10485760,null);
create policy fixture_private_media on storage.objects as restrictive for all to authenticated
 using(bucket_id<>'cleanmap-media' or (storage.foldername(name))[1]=auth.uid()::text)
 with check(bucket_id<>'cleanmap-media' or (storage.foldername(name))[1]=auth.uid()::text);
'''
SNAPSHOT = '''
with base as (select c.oid,c.relname,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.relowner
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where (n.nspname='public' and c.relname in ('profiles','reports','feedback','report_votes'))
 or (n.nspname='storage' and c.relname in ('objects','buckets')) or (n.nspname='auth' and c.relname='users'))
select jsonb_build_object(
 'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
 'reports',(select jsonb_agg(to_jsonb(p) order by id) from public.reports p),
 'feedback',(select jsonb_agg(to_jsonb(p) order by id) from public.feedback p),
 'votes',(select jsonb_agg(to_jsonb(p) order by id) from public.report_votes p),
 'users',(select jsonb_agg(to_jsonb(p) order by id) from auth.users p),
 'buckets',(select jsonb_agg(to_jsonb(p) order by id) from storage.buckets p),
 'media',(select jsonb_agg(to_jsonb(p) order by id) from storage.objects p),
 'relations',(select jsonb_agg(to_jsonb(b) order by oid) from base b),
 'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p),
 'columns',(select jsonb_agg(to_jsonb(a) order by attrelid,attnum) from pg_attribute a
   where attrelid in (select oid from base) and attnum>0),
 'constraints',(select jsonb_agg(jsonb_build_array(conrelid,conname,pg_get_constraintdef(oid)) order by conrelid,conname)
   from pg_constraint where conrelid in (select oid from base)),
 'indexes',(select jsonb_agg(pg_get_indexdef(indexrelid) order by indexrelid) from pg_index where indrelid in (select oid from base)),
 'triggers',(select jsonb_agg(pg_get_triggerdef(oid) order by oid) from pg_trigger where tgrelid in (select oid from base) and not tgisinternal)
);
'''

def sql(text, db=DB, expected_error=None):
    result = subprocess.run(CMD + ['-d', db], input=text, text=True, capture_output=True)
    if expected_error:
        assert result.returncode != 0, 'Expected migration to abort'
        assert expected_error in result.stderr, result.stderr
    elif result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def snapshot():
    return json.loads(sql(SNAPSHOT))


def reset():
    # Only this explicitly named test database is reset, never the container's other databases.
    sql(f'DROP DATABASE IF EXISTS {DB}; CREATE DATABASE {DB} TEMPLATE template0;', db='postgres')
    fixture = (ROOT / 'tests/security-fixture.sql').read_text()
    for role in ('anon', 'authenticated'):
        if sql(f"select exists(select 1 from pg_roles where rolname='{role}')", db='postgres') == 't':
            fixture = fixture.replace(f'create role {role} nologin;', '')
    sql(fixture)
    sql(BASELINE_SECURITY)
    # Construct existing columns/security without claiming they came from a live audit.
    sql((ROOT / 'supabase/migrations/20261021_community.sql').read_text())
    sql(DROP_API)


def assert_contract():
    source = (ROOT / 'community.js').read_text()
    for view, constant in [('cleanmap_public_profiles', 'PUBLIC_PROFILE_FIELDS'),
                           ('cleanmap_report_directory', 'DIRECTORY_FIELDS')]:
        expected = re.search(r"const " + constant + r" = '([^']+)'", source).group(1).split(',')
        actual = sql(f"select attname from pg_attribute where attrelid='public.{view}'::regclass and attnum>0 and not attisdropped order by attnum").splitlines()
        assert set(actual) == set(expected) and len(actual) == len(expected), (view, actual)
    expected = {
        'cleanmap_ensure_profile': ['', 'void', True],
        'cleanmap_save_profile': ['p_username text, p_display_name text, p_bio text, p_city text, p_barangay text, p_avatar_url text', 'void', True],
        'cleanmap_report_areas': ['', 'TABLE(city text, barangay text)', False],
        'cleanmap_report_statistics': ['', 'jsonb', False],
    }
    actual = json.loads(sql("""select jsonb_object_agg(proname,jsonb_build_array(pg_get_function_arguments(oid),pg_get_function_result(oid),prosecdef))
      from pg_proc where pronamespace='public'::regnamespace and proname in
      ('cleanmap_ensure_profile','cleanmap_save_profile','cleanmap_report_areas','cleanmap_report_statistics')"""))
    assert actual == expected
    params = re.search(r"rpc\('cleanmap_save_profile',\{([^}]+)\}", source).group(1)
    assert re.findall(r'(p_\w+):', params) == [p.split()[0] for p in expected['cleanmap_save_profile'][0].split(', ')]


reset()
before = snapshot()
sql(MIGRATION)
assert snapshot() == before, 'Installation must preserve base records and security'
assert_contract()
sql(MIGRATION)
assert snapshot() == before, 'Rerun must preserve records/security'
sql('drop function public.cleanmap_report_statistics();')
sql(MIGRATION)
assert snapshot() == before
print('PASS six-object installation, exact JS contract, repeat/partial repeat, unchanged data/security/Storage')

# Existing mandatory security assertions plus explicit all-authenticated feedback/media tests.
sql((ROOT / 'tests/security-regression.sql').read_text())
sql((ROOT / 'tests/community-api-regression.sql').read_text())
print('PASS existing security suite; public projection/privacy, own profile/feedback, all-member feedback reads, admin guards and private media')

# Fresh simulated schemas isolate each failure. Failure must roll back API DDL too.
for preparation, message in [
    ('alter table public.reports drop column city;', 'Missing columns on public.reports: city'),
    ("alter table public.profiles add column legacy_required text not null default 'existing'; alter table public.profiles alter column legacy_required drop default;", 'mandatory field: legacy_required'),
    ('drop index public.cleanmap_username_unique;', 'unique index on lower(profiles.username)'),
    ('alter table public.feedback disable row level security;', 'Existing RLS must be audited/enabled'),
    ('create view public.cleanmap_report_directory as select 1 as id;', 'differs from this repair'),
    ("create function public.cleanmap_ensure_profile(unexpected text) returns void language sql as 'select';", 'Unexpected overload'),
]:
    reset()
    sql(preparation)
    before = snapshot()
    sql(MIGRATION, expected_error=message)
    assert snapshot() == before
    assert sql("select to_regclass('public.cleanmap_public_profiles') is null") == 't', 'Failed migration must roll back preceding objects'
    print('PASS atomic refusal:', message)

reset()
sql("create type public.fixture_severity as enum ('low','moderate','high','severe'); alter table public.reports alter severity type public.fixture_severity using severity::public.fixture_severity; alter table public.report_votes alter severity type public.fixture_severity using severity::public.fixture_severity;")
sql(MIGRATION)
assert_contract()
sql(MIGRATION)
sql((ROOT / 'tests/security-regression.sql').read_text())
print('PASS native enum severities, repeated migration, and original voting/privacy/admin security assertions')

# Detect security drift on existing objects without resetting their grants/definitions.
sql('grant select(description) on public.cleanmap_report_directory to anon;')
sql(MIGRATION, expected_error='different security options/grants')
assert sql("select has_column_privilege('anon','public.cleanmap_report_directory','description','SELECT')") == 't'
print('PASS refusal of unexpected column grant without silently changing existing permissions')
