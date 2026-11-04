-- App-owned history and private media only. Existing assignment history,
-- model rows, profile policies, storage buckets and storage guards are preserved.
begin;
select pg_advisory_xact_lock(hashtext('chainlab:history-install'));
do $guard$
begin
  if to_regprocedure('public.chainlab_is_superadmin()') is null
     or to_regclass('public.prompt_chains') is null then
    raise exception 'Install Chainlab authorization and the existing assignment schema first';
  end if;
  if to_regclass('public.chainlab_runs') is not null then
    raise exception 'chainlab_runs already exists; installation aborted without adopting it';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('chainlab_list_runs','chainlab_create_run','chainlab_update_run','chainlab_can_access_media')) then
    raise exception 'A Chainlab history function already exists; installation aborted without replacing it';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'Supabase Storage is required for private Chainlab media';
  end if;
  if exists(select 1 from storage.buckets where id='chainlab-generated-media' or name='chainlab-generated-media') then
    raise exception 'The Chainlab media bucket already exists; installation aborted without adopting it';
  end if;
  if exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname in ('chainlab_generated_media_read','chainlab_generated_media_insert','chainlab_generated_media_delete','chainlab_generated_media_guard')) then
    raise exception 'A Chainlab media policy already exists; installation aborted without replacing it';
  end if;
end;
$guard$;

create table public.chainlab_runs (
  id uuid primary key default gen_random_uuid(),
  chain_id uuid not null references public.prompt_chains(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  status text not null default 'running' check(status in ('running','completed','failed')),
  input text not null check(char_length(input) between 1 and 16000),
  outputs jsonb not null default '[]'::jsonb check(jsonb_typeof(outputs)='array' and jsonb_array_length(outputs)<=10),
  error text check(char_length(error)<=1000),
  created_at timestamptz not null default now()
);
create index chainlab_runs_chain_created_at on public.chainlab_runs(chain_id,created_at desc,id desc);
alter table public.chainlab_runs enable row level security;
revoke all on public.chainlab_runs from public,anon,authenticated;

create function public.chainlab_list_runs(p_chain_id uuid)
returns setof public.chainlab_runs language plpgsql stable security definer set search_path=''
as $$
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501';end if;
  if not exists(select 1 from public.prompt_chains where id=p_chain_id) then
    raise exception 'Prompt chain not found' using errcode='P0002';end if;
  return query select * from public.chainlab_runs where chain_id=p_chain_id order by created_at desc,id desc limit 50;
end;
$$;

create function public.chainlab_create_run(p_chain_id uuid,p_input text)
returns public.chainlab_runs language plpgsql security definer set search_path=''
as $$
declare v_run public.chainlab_runs;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501';end if;
  if p_input is null or char_length(p_input) not between 1 and 16000 then
    raise exception 'Run input must contain 1 to 16000 characters' using errcode='22023';end if;
  perform 1 from public.prompt_chains where id=p_chain_id for key share;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002';end if;
  insert into public.chainlab_runs(chain_id,created_by,input)
  values(p_chain_id,auth.uid(),p_input) returning * into v_run;
  return v_run;
end;
$$;

create function public.chainlab_update_run(p_run_id uuid,p_status text,p_outputs jsonb,p_error text)
returns public.chainlab_runs language plpgsql security definer set search_path=''
as $$
declare v_run public.chainlab_runs;v_output jsonb;v_step_id uuid;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501';end if;
  select * into v_run from public.chainlab_runs where id=p_run_id for update;
  if not found then raise exception 'Run not found' using errcode='P0002';end if;
  if v_run.created_by is distinct from auth.uid() then raise exception 'Only the run creator may update it' using errcode='42501';end if;
  if p_status is null or p_status not in ('running','completed','failed')
     or p_outputs is null or jsonb_typeof(p_outputs)<>'array' then
    raise exception 'Invalid run status or outputs' using errcode='22023';end if;
  if jsonb_array_length(p_outputs)>10 or octet_length(p_outputs::text)>1000000
     or (p_status='completed' and jsonb_array_length(p_outputs)=0)
     or (p_status='failed' and (p_error is null or char_length(p_error) not between 1 and 1000))
     or (p_status<>'failed' and p_error is not null) then
    raise exception 'Invalid run result' using errcode='22023';end if;
  if v_run.status<>'running' then
    if v_run.status=p_status and v_run.outputs=p_outputs and v_run.error is not distinct from p_error then return v_run;end if;
    raise exception 'A finished run cannot be changed or reopened' using errcode='55000';end if;
  if jsonb_array_length(p_outputs)<jsonb_array_length(v_run.outputs)
     or exists(select 1 from jsonb_array_elements(v_run.outputs) with ordinality old(value,position)
       where p_outputs->((old.position-1)::integer) is distinct from old.value) then
    raise exception 'Previously saved step outputs cannot be replaced' using errcode='22023';end if;
  for v_output in select value from jsonb_array_elements(p_outputs) loop
    if jsonb_typeof(v_output)<>'object'
       or exists(select 1 from jsonb_object_keys(v_output) k where k not in ('step_id','step_name','kind','content','image_path'))
       or jsonb_typeof(v_output->'step_id') is distinct from 'string'
       or jsonb_typeof(v_output->'step_name') is distinct from 'string'
       or char_length(v_output->>'step_name') not between 1 and 120
       or jsonb_typeof(v_output->'kind') is distinct from 'string'
       or v_output->>'kind' not in ('text','image')
       or jsonb_typeof(v_output->'content') is distinct from 'string' then
      raise exception 'Invalid step output' using errcode='22023';end if;
    begin v_step_id:=(v_output->>'step_id')::uuid;
    exception when invalid_text_representation then raise exception 'Invalid step output UUID' using errcode='22023';end;
    if (v_output->>'kind'='text' and (v_output?'image_path' or char_length(v_output->>'content')=0))
       or (v_output->>'kind'='image' and (
         v_output->>'content'<>'' or jsonb_typeof(v_output->'image_path') is distinct from 'string'
         or v_output->>'image_path'<>v_run.chain_id::text||'/'||v_run.id::text||'/'||v_step_id::text||'.png')) then
      raise exception 'Images must use this run private storage path; text must contain text only' using errcode='22023';end if;
  end loop;
  if (select count(distinct value->>'step_id') from jsonb_array_elements(p_outputs))<>jsonb_array_length(p_outputs) then
    raise exception 'Each step output may be recorded only once' using errcode='22023';end if;
  update public.chainlab_runs set status=p_status,outputs=p_outputs,error=p_error where id=p_run_id returning * into v_run;
  return v_run;
end;
$$;

revoke all on function public.chainlab_list_runs(uuid),public.chainlab_create_run(uuid,text),public.chainlab_update_run(uuid,text,jsonb,text) from public,anon;
grant execute on function public.chainlab_list_runs(uuid),public.chainlab_create_run(uuid,text),public.chainlab_update_run(uuid,text,jsonb,text) to authenticated;

-- This helper exposes only a current-session boolean. Anonymous callers must
-- be able to evaluate the bucket guard without changing authorization RPC ACLs
-- or causing an execution-permission failure while reading another bucket.
create function public.chainlab_can_access_media()
returns boolean language sql stable security definer set search_path=''
as $$select public.chainlab_is_superadmin() is true;$$;
revoke all on function public.chainlab_can_access_media() from public,anon,authenticated;
grant execute on function public.chainlab_can_access_media() to anon,authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chainlab-generated-media','chainlab-generated-media',false,20971520,array['image/png']);
-- Existing permissive policies cannot grant a nonadmin access to this bucket.
-- Every other bucket keeps exactly its prior policy behavior.
create policy chainlab_generated_media_guard on storage.objects as restrictive for all to public
using(bucket_id<>'chainlab-generated-media' or (select public.chainlab_can_access_media()))
with check(bucket_id<>'chainlab-generated-media' or (select public.chainlab_can_access_media()));
-- Existing restrictive guards still apply. The app checks Storage access before
-- an image generation request; these policies never loosen another bucket.
create policy chainlab_generated_media_read on storage.objects for select to authenticated
using(bucket_id='chainlab-generated-media' and (select public.chainlab_is_superadmin()));
create policy chainlab_generated_media_insert on storage.objects for insert to authenticated
with check(bucket_id='chainlab-generated-media' and (select public.chainlab_is_superadmin()));
create policy chainlab_generated_media_delete on storage.objects for delete to authenticated
using(bucket_id='chainlab-generated-media' and (select public.chainlab_is_superadmin()));
notify pgrst,'reload schema';
commit;
