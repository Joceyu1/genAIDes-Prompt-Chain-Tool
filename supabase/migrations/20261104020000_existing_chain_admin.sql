-- Install Chainlab administration alongside the assignment's existing schema.
-- Existing chain tables, constraints, policies, model UUIDs and data are not altered.
begin;

select pg_advisory_xact_lock(hashtext('chainlab:existing-chain-admin-install'));
do $guard$
declare v_name text;
begin
  if to_regprocedure('public.chainlab_is_superadmin()') is null then
    raise exception 'Install the authorization-only superadmin repair first';
  end if;
  if to_regclass('public.prompt_chains') is null or to_regclass('public.prompt_chain_steps') is null then
    raise exception 'The existing assignment prompt chain tables are required';
  end if;
  if to_regclass('public.chainlab_step_settings') is not null then
    raise exception 'chainlab_step_settings already exists; installation aborted without adopting it';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'chainlab_list_chains','chainlab_get_chain','chainlab_create_chain',
      'chainlab_update_chain','chainlab_delete_chain','chainlab_append_step',
      'chainlab_update_step','chainlab_delete_step','chainlab_reorder_steps'
    )
  ) then
    raise exception 'A Chainlab administration function already exists; installation aborted without replacing it';
  end if;
  foreach v_name in array array['id','name','description','is_active','source','updated_at'] loop
    if not exists(select 1 from pg_attribute where attrelid='public.prompt_chains'::regclass and attname=v_name and not attisdropped and attnum>0) then
      raise exception 'Existing prompt_chains is missing required column %',v_name;
    end if;
  end loop;
  foreach v_name in array array['id','chain_id','position','role','template','model_id','updated_at'] loop
    if not exists(select 1 from pg_attribute where attrelid='public.prompt_chain_steps'::regclass and attname=v_name and not attisdropped and attnum>0) then
      raise exception 'Existing prompt_chain_steps is missing required column %',v_name;
    end if;
  end loop;
  if exists(select 1 from pg_attribute where attrelid in ('public.prompt_chains'::regclass,'public.prompt_chain_steps'::regclass) and attname='id' and atttypid<>'uuid'::regtype)
     or exists(select 1 from pg_attribute where attrelid='public.prompt_chain_steps'::regclass and attname in ('chain_id','model_id') and atttypid<>'uuid'::regtype)
     or exists(select 1 from pg_attribute where attrelid='public.prompt_chain_steps'::regclass and attname='position' and atttypid<>'integer'::regtype)
     or exists(select 1 from pg_attribute where attrelid='public.prompt_chains'::regclass and attname='is_active' and atttypid<>'boolean'::regtype) then
    raise exception 'Existing prompt chain column types are incompatible; no changes made';
  end if;
end;
$guard$;

create table public.chainlab_step_settings (
  step_id uuid primary key references public.prompt_chain_steps(id) on delete cascade,
  name text not null check(char_length(btrim(name)) between 1 and 120),
  kind text not null check(kind in ('text','image')),
  fallback_model text not null check(char_length(fallback_model) between 1 and 200),
  updated_at timestamptz not null default now()
);
alter table public.chainlab_step_settings enable row level security;
revoke all on public.chainlab_step_settings from public,anon,authenticated;

create function public.chainlab_list_chains()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501'; end if;
  return jsonb_build_object(
    'chains',coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from public.prompt_chains c),'[]'::jsonb),
    'steps',coalesce((select jsonb_agg(to_jsonb(s) order by s.chain_id,s.position) from public.prompt_chain_steps s),'[]'::jsonb),
    'settings',coalesce((select jsonb_agg(to_jsonb(t) order by t.step_id) from public.chainlab_step_settings t),'[]'::jsonb)
  );
end;
$$;

create function public.chainlab_get_chain(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare v_result jsonb;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'chain',to_jsonb(c),
    'steps',coalesce((select jsonb_agg(to_jsonb(s) order by s.position) from public.prompt_chain_steps s where s.chain_id=c.id),'[]'::jsonb),
    'settings',coalesce((select jsonb_agg(to_jsonb(t) order by t.step_id) from public.chainlab_step_settings t join public.prompt_chain_steps s on s.id=t.step_id where s.chain_id=c.id),'[]'::jsonb)
  ) into v_result from public.prompt_chains c where c.id=p_id;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002'; end if;
  return v_result;
end;
$$;

create function public.chainlab_create_chain(p_name text,p_description text,p_is_active boolean)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_id uuid;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501'; end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120
     or p_description is null or char_length(p_description)>2000 or p_is_active is null then
    raise exception 'Invalid prompt chain fields' using errcode='22023';
  end if;
  insert into public.prompt_chains(name,description,is_active) values(btrim(p_name),p_description,p_is_active) returning id into v_id;
  return public.chainlab_get_chain(v_id);
end;
$$;

create function public.chainlab_update_chain(p_id uuid,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_chain public.prompt_chains;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select * into v_chain from public.prompt_chains where id=p_id for update;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002'; end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb
     or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('name','description','is_active')) then
    raise exception 'Supply only editable chain fields' using errcode='22023';
  end if;
  if p_patch?'name' then
    if jsonb_typeof(p_patch->'name')<>'string' or char_length(btrim(p_patch->>'name')) not between 1 and 120 then raise exception 'Invalid chain name' using errcode='22023'; end if;
    v_chain.name:=btrim(p_patch->>'name');
  end if;
  if p_patch?'description' then
    if jsonb_typeof(p_patch->'description')<>'string' or char_length(p_patch->>'description')>2000 then raise exception 'Invalid chain description' using errcode='22023'; end if;
    v_chain.description:=p_patch->>'description';
  end if;
  if p_patch?'is_active' then
    if jsonb_typeof(p_patch->'is_active')<>'boolean' then raise exception 'Invalid active flag' using errcode='22023'; end if;
    v_chain.is_active:=(p_patch->>'is_active')::boolean;
  end if;
  update public.prompt_chains set name=v_chain.name,description=v_chain.description,is_active=v_chain.is_active,updated_at=now() where id=p_id;
  return public.chainlab_get_chain(p_id);
end;
$$;

create function public.chainlab_delete_chain(p_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501'; end if;
  perform 1 from public.prompt_chains where id=p_id for update;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002'; end if;
  perform 1 from public.prompt_chain_steps where chain_id=p_id order by position,id for update;
  delete from public.prompt_chain_steps where chain_id=p_id;
  -- Existing RESTRICT references remain authoritative. Any failure rolls back
  -- the preceding step deletion and the sidecar's cascading deletion.
  delete from public.prompt_chains where id=p_id;
end;
$$;

create function public.chainlab_update_step(p_chain_id uuid,p_step_id uuid,p_step jsonb,p_settings jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_step public.prompt_chain_steps; v_settings public.chainlab_step_settings;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501'; end if;
  perform 1 from public.prompt_chains where id=p_chain_id for update;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002'; end if;
  perform 1 from public.prompt_chain_steps where chain_id=p_chain_id order by position,id for update;
  select * into v_step from public.prompt_chain_steps where id=p_step_id and chain_id=p_chain_id;
  if not found then raise exception 'Prompt chain step not found' using errcode='P0002'; end if;
  p_step:=coalesce(p_step,'{}'::jsonb); p_settings:=coalesce(p_settings,'{}'::jsonb);
  if jsonb_typeof(p_step)<>'object' or jsonb_typeof(p_settings)<>'object'
     or exists(select 1 from jsonb_object_keys(p_step) k where k not in ('role','template','model_id'))
     or exists(select 1 from jsonb_object_keys(p_settings) k where k not in ('name','kind','fallback_model')) then
    raise exception 'Invalid step or display settings fields' using errcode='22023';
  end if;
  if p_step?'role' then
    if jsonb_typeof(p_step->'role')<>'string' or p_step->>'role' not in ('system','user','assistant') then raise exception 'Invalid prompt role' using errcode='22023'; end if;
    v_step.role:=p_step->>'role';
  end if;
  if p_step?'template' then
    if jsonb_typeof(p_step->'template')<>'string' or char_length(p_step->>'template') not between 1 and 2000 then raise exception 'Prompt template must contain 1 to 2000 characters' using errcode='22023'; end if;
    v_step.template:=p_step->>'template';
  end if;
  if p_step?'model_id' then
    if jsonb_typeof(p_step->'model_id')='null' then v_step.model_id:=null;
    elsif jsonb_typeof(p_step->'model_id')='string' then
      begin v_step.model_id:=(p_step->>'model_id')::uuid;
      exception when invalid_text_representation then raise exception 'Invalid model UUID' using errcode='22023'; end;
    else raise exception 'Invalid model UUID' using errcode='22023'; end if;
  end if;
  select * into v_settings from public.chainlab_step_settings where step_id=p_step_id;
  if not found then v_settings.name:='Step '||v_step.position;v_settings.kind:='text';v_settings.fallback_model:='gpt-4.1-mini';end if;
  if p_settings?'name' then
    if jsonb_typeof(p_settings->'name')<>'string' then raise exception 'Invalid step name' using errcode='22023';end if;
    v_settings.name:=btrim(p_settings->>'name');
  end if;
  if p_settings?'kind' then
    if jsonb_typeof(p_settings->'kind')<>'string' then raise exception 'Invalid output kind' using errcode='22023';end if;
    v_settings.kind:=p_settings->>'kind';
  end if;
  if p_settings?'fallback_model' then
    if jsonb_typeof(p_settings->'fallback_model')<>'string' then raise exception 'Invalid fallback model' using errcode='22023';end if;
    -- Registry assignments remain authoritative, including inactive or
    -- unsupported providers. An unresolved UI label must not rewrite the UUID
    -- or prevent editing the existing prompt.
    if v_step.model_id is null then v_settings.fallback_model:=p_settings->>'fallback_model';end if;
  end if;
  if char_length(btrim(v_settings.name)) not between 1 and 120 or v_settings.kind not in ('text','image')
     or char_length(v_settings.fallback_model) not between 1 and 200 then raise exception 'Invalid step display settings' using errcode='22023';end if;
  if v_step.model_id is null and not (
    (v_settings.kind='text' and (
      v_settings.fallback_model in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini')
      or v_settings.fallback_model ~ '^gemini-([0-9]+([.][0-9]+)?-flash(-lite)?(-(001|latest|preview(-[0-9]{2}(-[0-9]{2,4})?)?))?|flash-lite-latest)$'
    ))
    or (v_settings.kind='image' and v_settings.fallback_model='gpt-image-1')
  ) then raise exception 'Choose a supported fallback model when no registry model is assigned' using errcode='22023';end if;
  update public.prompt_chain_steps set role=v_step.role,template=v_step.template,model_id=v_step.model_id,updated_at=now() where id=p_step_id returning * into v_step;
  insert into public.chainlab_step_settings(step_id,name,kind,fallback_model)
  values(p_step_id,v_settings.name,v_settings.kind,v_settings.fallback_model)
  on conflict(step_id) do update set name=excluded.name,kind=excluded.kind,fallback_model=excluded.fallback_model,updated_at=now()
  returning * into v_settings;
  update public.prompt_chains set updated_at=now() where id=p_chain_id;
  return jsonb_build_object('step',to_jsonb(v_step),'settings',to_jsonb(v_settings));
end;
$$;

create function public.chainlab_append_step(p_chain_id uuid,p_step jsonb,p_settings jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_count integer;v_position integer:=1;v_existing record;v_step public.prompt_chain_steps;v_role text:='user';v_template text;v_model uuid;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501';end if;
  perform 1 from public.prompt_chains where id=p_chain_id for update;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002';end if;
  perform 1 from public.prompt_chain_steps where chain_id=p_chain_id order by position,id for update;
  p_step:=coalesce(p_step,'{}'::jsonb);
  if jsonb_typeof(p_step)<>'object' or exists(select 1 from jsonb_object_keys(p_step) k where k not in ('role','template','model_id')) then raise exception 'Invalid step fields' using errcode='22023';end if;
  if p_step?'role' then
    if jsonb_typeof(p_step->'role')<>'string' or p_step->>'role' not in ('system','user','assistant') then raise exception 'Invalid prompt role' using errcode='22023';end if;
    v_role:=p_step->>'role';
  end if;
  if not p_step?'template' or jsonb_typeof(p_step->'template')<>'string' or char_length(p_step->>'template') not between 1 and 2000 then raise exception 'Prompt template must contain 1 to 2000 characters' using errcode='22023';end if;
  v_template:=p_step->>'template';
  if p_step?'model_id' and jsonb_typeof(p_step->'model_id')<>'null' then
    if jsonb_typeof(p_step->'model_id')<>'string' then raise exception 'Invalid model UUID' using errcode='22023';end if;
    begin v_model:=(p_step->>'model_id')::uuid;
    exception when invalid_text_representation then raise exception 'Invalid model UUID' using errcode='22023';end;
  end if;
  select count(*) into v_count from public.prompt_chain_steps where chain_id=p_chain_id;
  if v_count>=1000 then raise exception 'This chain has reached the 1000-step position limit' using errcode='22023';end if;
  -- An ascending compaction only moves rows into empty lower slots, preserving
  -- the existing immediate unique constraint and positive position check.
  for v_existing in select id,position from public.prompt_chain_steps where chain_id=p_chain_id order by position,id loop
    if v_existing.position<>v_position then update public.prompt_chain_steps set position=v_position,updated_at=now() where id=v_existing.id;end if;
    v_position:=v_position+1;
  end loop;
  insert into public.prompt_chain_steps(chain_id,position,role,template,model_id)
  values(p_chain_id,v_count+1,v_role,v_template,v_model) returning * into v_step;
  -- The shared update path validates settings and writes them atomically with
  -- the inserted step. An invalid setting rolls back compaction and insertion.
  return public.chainlab_update_step(p_chain_id,v_step.id,'{}'::jsonb,p_settings);
end;
$$;

create function public.chainlab_delete_step(p_chain_id uuid,p_step_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
declare v_position integer:=1;v_existing record;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501';end if;
  perform 1 from public.prompt_chains where id=p_chain_id for update;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002';end if;
  perform 1 from public.prompt_chain_steps where chain_id=p_chain_id order by position,id for update;
  delete from public.prompt_chain_steps where chain_id=p_chain_id and id=p_step_id;
  if not found then raise exception 'Prompt chain step not found' using errcode='P0002';end if;
  for v_existing in select id,position from public.prompt_chain_steps where chain_id=p_chain_id order by position,id loop
    if v_existing.position<>v_position then update public.prompt_chain_steps set position=v_position,updated_at=now() where id=v_existing.id;end if;
    v_position:=v_position+1;
  end loop;
  update public.prompt_chains set updated_at=now() where id=p_chain_id;
end;
$$;

create function public.chainlab_reorder_steps(p_chain_id uuid,p_step_ids uuid[])
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_count integer;v_current uuid[];v_desired uuid;v_at_target uuid;v_free integer;v_position integer:=1;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501';end if;
  perform 1 from public.prompt_chains where id=p_chain_id for update;
  if not found then raise exception 'Prompt chain not found' using errcode='P0002';end if;
  perform 1 from public.prompt_chain_steps where chain_id=p_chain_id order by position,id for update;
  select count(*),coalesce(array_agg(id order by position,id),array[]::uuid[]) into v_count,v_current from public.prompt_chain_steps where chain_id=p_chain_id;
  if p_step_ids is null or cardinality(p_step_ids)<>v_count
     or (select count(distinct id) from unnest(p_step_ids) ids(id))<>v_count
     or exists(select 1 from unnest(p_step_ids) ids(id) where not exists(select 1 from public.prompt_chain_steps s where s.chain_id=p_chain_id and s.id=ids.id)) then
    raise exception 'Step IDs must contain every current step exactly once' using errcode='22023';end if;
  if v_count=1000 then
    if v_current=p_step_ids then update public.prompt_chains set updated_at=now() where id=p_chain_id;return public.chainlab_get_chain(p_chain_id);end if;
    raise exception 'Reordering 1000 occupied positions needs a free slot; remove a step first' using errcode='22023';
  end if;
  foreach v_desired in array p_step_ids loop
    select id into v_at_target from public.prompt_chain_steps where chain_id=p_chain_id and position=v_position;
    if v_at_target is distinct from v_desired then
      if v_at_target is not null then
        select candidate into v_free from generate_series(1,1000) candidate
        where not exists(select 1 from public.prompt_chain_steps s where s.chain_id=p_chain_id and s.position=candidate)
        order by candidate limit 1;
        if v_free is null then raise exception 'No free step position is available' using errcode='22023';end if;
        update public.prompt_chain_steps set position=v_free,updated_at=now() where id=v_at_target;
      end if;
      update public.prompt_chain_steps set position=v_position,updated_at=now() where id=v_desired;
    end if;
    v_position:=v_position+1;
  end loop;
  update public.prompt_chains set updated_at=now() where id=p_chain_id;
  return public.chainlab_get_chain(p_chain_id);
end;
$$;

revoke all on function public.chainlab_list_chains(),public.chainlab_get_chain(uuid),public.chainlab_create_chain(text,text,boolean),public.chainlab_update_chain(uuid,jsonb),public.chainlab_delete_chain(uuid),public.chainlab_append_step(uuid,jsonb,jsonb),public.chainlab_update_step(uuid,uuid,jsonb,jsonb),public.chainlab_delete_step(uuid,uuid),public.chainlab_reorder_steps(uuid,uuid[]) from public,anon;
grant execute on function public.chainlab_list_chains(),public.chainlab_get_chain(uuid),public.chainlab_create_chain(text,text,boolean),public.chainlab_update_chain(uuid,jsonb),public.chainlab_delete_chain(uuid),public.chainlab_append_step(uuid,jsonb,jsonb),public.chainlab_update_step(uuid,uuid,jsonb,jsonb),public.chainlab_delete_step(uuid,uuid),public.chainlab_reorder_steps(uuid,uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
