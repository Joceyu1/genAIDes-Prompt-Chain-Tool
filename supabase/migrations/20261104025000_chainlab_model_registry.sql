-- Read the existing assignment model registry without exposing provider configuration.
begin;

select pg_advisory_xact_lock(hashtext('chainlab:model-registry-install'));
do $guard$
declare v_column record;
begin
  if not exists (
    select 1 from pg_proc
    where oid=to_regprocedure('public.chainlab_is_superadmin()')
      and prorettype='boolean'::regtype and pronargs=0
  ) then
    raise exception 'The no-argument Boolean Chainlab superadmin predicate is required';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='chainlab_list_models'
  ) then
    raise exception 'chainlab_list_models already exists; installation aborted without replacing it';
  end if;
  if not exists(select 1 from pg_class where oid=to_regclass('public.llm_models') and relkind in ('r','p'))
     or not exists(select 1 from pg_class where oid=to_regclass('public.llm_providers') and relkind in ('r','p')) then
    raise exception 'The existing public model and provider registry tables are required';
  end if;
  for v_column in
    select * from (values
      ('public.llm_models','id','uuid'),
      ('public.llm_models','provider_id','uuid'),
      ('public.llm_models','name','text'),
      ('public.llm_models','model_key','text'),
      ('public.llm_models','is_active','boolean'),
      ('public.llm_providers','id','uuid'),
      ('public.llm_providers','slug','text'),
      ('public.llm_providers','is_active','boolean')
    ) as required(table_name,column_name,type_name)
  loop
    if not exists (
      select 1 from pg_attribute
      where attrelid=to_regclass(v_column.table_name)
        and attname=v_column.column_name and attnum>0 and not attisdropped
        and atttypid=to_regtype(v_column.type_name)
    ) then
      raise exception 'Existing registry %.% is missing or has an incompatible type',v_column.table_name,v_column.column_name;
    end if;
  end loop;
end;
$guard$;

create function public.chainlab_list_models()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if public.chainlab_is_superadmin() is not true then
    raise exception 'Superadmin access required' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',m.id,
      'label',coalesce(nullif(btrim(m.name),''),nullif(btrim(m.model_key),''),'Unnamed model'),
      'model',coalesce(m.model_key,''),
      'provider',lower(coalesce(p.slug,'')),
      'kind',case
        when m.model_key='gpt-image-1' then 'image'
        when m.model_key in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini') then 'text'
        else null
      end,
      'active',m.is_active is true and p.is_active is true
    ) order by lower(coalesce(p.slug,'')),coalesce(m.name,''),m.id)
    from public.llm_models m
    left join public.llm_providers p on p.id=m.provider_id
  ),'[]'::jsonb);
end;
$$;

revoke all on function public.chainlab_list_models() from public,anon;
grant execute on function public.chainlab_list_models() to authenticated;
notify pgrst,'reload schema';
commit;
