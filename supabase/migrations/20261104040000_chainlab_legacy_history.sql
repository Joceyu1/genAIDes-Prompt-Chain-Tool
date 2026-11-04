-- A read-only text projection of existing assignment history. No legacy row,
-- policy, constraint, storage object, or media URL is adopted or changed.
begin;
select pg_advisory_xact_lock(hashtext('chainlab:legacy-history-install'));
do $guard$
declare v_table text;v_column text;v_required text[];v_target text;v_count integer;
begin
  if to_regprocedure('public.chainlab_is_superadmin()') is null then
    raise exception 'Install Chainlab authorization first';end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='chainlab_list_legacy_history') then
    raise exception 'A Chainlab saved-history function already exists; installation aborted without replacing it';end if;
  foreach v_table in array array['prompt_chains','ai_generation_examples','generation_requests','generations'] loop
    if to_regclass('public.'||v_table) is null then raise exception 'Existing assignment table % is required',v_table;end if;
    v_required:=case v_table
      when 'prompt_chains' then array['id']
      when 'ai_generation_examples' then array['id','chain_id','prompt','output','is_active','created_at']
      when 'generation_requests' then array['id','chain_id','generation_id','prompt','status','model_key','source','created_at']
      else array['prompt','title','caption','model','status','created_at'] end;
    foreach v_column in array v_required loop
      if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||v_table)
        and attname=v_column and not attisdropped and attnum>0) then
        raise exception 'Existing %.% is required; no changes made',v_table,v_column;end if;
    end loop;
  end loop;
  -- Discover the actual referenced UUID column. The generations primary key's
  -- name is deliberately not assumed, and composite/ambiguous FKs are rejected.
  select count(*),min(case when k.confrelid='public.generations'::regclass
    and cardinality(k.conkey)=1 and cardinality(k.confkey)=1 and target.atttypid='uuid'::regtype
    and source.atttypid='uuid'::regtype then target.attname end)
  into v_count,v_target
  from pg_constraint k join pg_attribute source on source.attrelid=k.conrelid and source.attname='generation_id' and source.attnum=any(k.conkey)
  left join pg_attribute target on target.attrelid=k.confrelid and target.attnum=k.confkey[1] and not target.attisdropped
  where k.contype='f' and k.conrelid='public.generation_requests'::regclass;
  if v_count<>1 or v_target is null then
    raise exception 'Expected one UUID generation_requests.generation_id foreign key to public.generations; installation aborted';end if;
end;
$guard$;

create function public.chainlab_list_legacy_history(p_chain_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare v_target text;v_count integer;v_result jsonb;
begin
  if public.chainlab_is_superadmin() is not true then raise exception 'Superadmin access required' using errcode='42501';end if;
  if not exists(select 1 from public.prompt_chains where id=p_chain_id) then
    raise exception 'Prompt chain not found' using errcode='P0002';end if;
  select count(*),min(case when k.confrelid='public.generations'::regclass
    and cardinality(k.conkey)=1 and cardinality(k.confkey)=1 and target.atttypid='uuid'::regtype
    and source.atttypid='uuid'::regtype then target.attname end)
  into v_count,v_target
  from pg_constraint k join pg_attribute source on source.attrelid=k.conrelid and source.attname='generation_id' and source.attnum=any(k.conkey)
  left join pg_attribute target on target.attrelid=k.confrelid and target.attnum=k.confkey[1] and not target.attisdropped
  where k.contype='f' and k.conrelid='public.generation_requests'::regclass;
  if v_count<>1 or v_target is null then
    raise exception 'The assignment generation foreign key changed; review the Chainlab saved-history setup' using errcode='55000';end if;
  execute format($query$
    select coalesce(jsonb_agg(entry order by created_at desc,source,id desc),'[]'::jsonb)
    from (
      select jsonb_build_object(
        'source','saved_example','id',e.id,'chain_id',e.chain_id,'created_at',e.created_at,
        'prompt',left(e.prompt,16000),'status',case when e.is_active then 'saved' else 'inactive' end,
        'output',left(e.output,20000),'title',null,'caption',null,'model',null,'origin',null,
        'generation_prompt',null,'generation_status',null,
        'truncated',char_length(e.prompt)>16000 or char_length(e.output)>20000
      ) as entry,e.created_at,'saved_example' as source,e.id
      from public.ai_generation_examples e where e.chain_id=$1
      union all
      select jsonb_build_object(
        'source','generation_request','id',r.id,'chain_id',r.chain_id,'created_at',r.created_at,
        'prompt',left(r.prompt,16000),'status',left(r.status,200),'output',null,
        'title',left(g.title,2000),'caption',left(g.caption,20000),
        'model',left(coalesce(g.model,r.model_key),200),'origin',left(r.source,200),
        'generation_prompt',left(g.prompt,16000),'generation_status',left(g.status,200),
        'truncated',char_length(r.prompt)>16000 or char_length(r.status)>200
          or coalesce(char_length(g.title)>2000,false) or coalesce(char_length(g.caption)>20000,false)
          or coalesce(char_length(g.prompt)>16000,false) or coalesce(char_length(g.status)>200,false)
          or coalesce(char_length(coalesce(g.model,r.model_key))>200,false) or char_length(r.source)>200
      ) as entry,r.created_at,'generation_request' as source,r.id
      from public.generation_requests r left join public.generations g on g.%I=r.generation_id
      where r.chain_id=$1
      order by created_at desc,source,id desc limit 50
    ) entries
  $query$,v_target) into v_result using p_chain_id;
  return v_result;
end;
$$;
revoke all on function public.chainlab_list_legacy_history(uuid) from public,anon;
grant execute on function public.chainlab_list_legacy_history(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
