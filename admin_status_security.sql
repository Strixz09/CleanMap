-- CleanMap: allow only administrators to change reports.verification_status.
-- Run this in Supabase SQL Editor after confirming public.is_admin() exists.
-- This keeps the existing owner/admin UPDATE policy for other report fields.

create or replace function public.cleanmap_guard_verification_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status is distinct from old.verification_status
     and not public.is_admin() then
    raise exception 'Only administrators can change report verification status.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists cleanmap_guard_verification_status on public.reports;
create trigger cleanmap_guard_verification_status
before update of verification_status on public.reports
for each row
execute function public.cleanmap_guard_verification_status();
