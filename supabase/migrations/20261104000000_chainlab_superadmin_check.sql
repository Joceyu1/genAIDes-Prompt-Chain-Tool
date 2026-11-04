-- Return only the signed-in user's existing role flag. This does not expose
-- profile rows or change the shared project's Columbia-only profile policies.
begin;

create or replace function public.chainlab_is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and is_superadmin is true
  );
$$;

-- No caller-supplied user ID, anonymous access, or default PUBLIC execution.
revoke all on function public.chainlab_is_superadmin() from public, anon;
grant execute on function public.chainlab_is_superadmin() to authenticated;

-- Make the newly created RPC visible to PostgREST after this transaction commits.
notify pgrst, 'reload schema';

commit;
