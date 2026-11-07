-- Enable Gemini text fallbacks in an already-installed Chainlab workspace.
-- Changes only the reviewed fallback-model predicate. No records, grants,
-- profile policies, class-table constraints, or model assignments are changed.
begin;
select pg_advisory_xact_lock(hashtext('chainlab:gemini-fallback-upgrade'));
do $upgrade$
declare v_target regprocedure;v_count integer;v_function record;v_owner_safe boolean;v_hash text;v_definition text;
begin
  if to_regclass('public.prompt_chains') is null
     or to_regclass('public.prompt_chain_steps') is null
     or to_regclass('public.chainlab_step_settings') is null then
    raise exception 'Install the existing-schema Chainlab workspace before enabling Gemini';
  end if;
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='chainlab_update_step';
  v_target:=to_regprocedure('public.chainlab_update_step(uuid,uuid,jsonb,jsonb)');
  if v_count<>1 or v_target is null then
    raise exception 'Expected one reviewed Chainlab step-update function; upgrade aborted without replacing anything';
  end if;
  select * into v_function from pg_proc where oid=v_target;
  if v_function.prokind<>'f' or v_function.proretset or v_function.prorettype<>'jsonb'::regtype
     or v_function.pronargs<>4 or v_function.provariadic<>0 or v_function.pronargdefaults<>0
     or v_function.proargnames is distinct from array['p_chain_id','p_step_id','p_step','p_settings']::text[]
     or v_function.prolang<>(select oid from pg_language where lanname='plpgsql')
     or not v_function.prosecdef or v_function.provolatile<>'v' or v_function.proisstrict
     or v_function.proconfig is distinct from array['search_path=""']::text[] then
    raise exception 'Unknown Chainlab step-update configuration; upgrade aborted without replacing it';
  end if;
  select r.rolname='postgres' or r.rolsuper or r.rolbypassrls or not exists(
    select 1 from pg_class c where c.oid in ('public.prompt_chains'::regclass,'public.prompt_chain_steps'::regclass,'public.chainlab_step_settings'::regclass)
      and (c.relowner<>r.oid or c.relforcerowsecurity)
  ) into v_owner_safe from pg_roles r where r.oid=v_function.proowner;
  if v_owner_safe is not true then
    raise exception 'The Chainlab step-update owner is not trusted for this upgrade';
  end if;
  -- Preserve comment boundaries and string contents when checking the body.
  -- Only Windows line endings are normalized; arbitrary formatting is not.
  v_hash:=md5(replace(v_function.prosrc,E'\r\n',E'\n'));
  if v_hash='6fc776fbafa499cb646373c2d7b6fe7e' then return;end if;
  if v_hash<>'a30484c8f12c6a91bf4a0fd9e5e53f40' then
    raise exception 'Unknown Chainlab step-update body; upgrade aborted without replacing it';
  end if;
  v_definition:=pg_get_functiondef(v_target);
  if (length(v_definition)-length(replace(v_definition,$old$(v_settings.kind='text' and v_settings.fallback_model in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini'))$old$,'')))
     <>length($old$(v_settings.kind='text' and v_settings.fallback_model in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini'))$old$) then
    raise exception 'The reviewed fallback predicate is not unique; upgrade aborted';
  end if;
  execute replace(v_definition,
    $old$(v_settings.kind='text' and v_settings.fallback_model in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini'))$old$,
    $new$(v_settings.kind='text' and (
      v_settings.fallback_model in ('gpt-4.1-mini','gpt-4.1','gpt-4o-mini')
      or v_settings.fallback_model ~ '^gemini-([0-9]+([.][0-9]+)?-flash(-lite)?(-(001|latest|preview(-[0-9]{2}(-[0-9]{2,4})?)?))?|flash-lite-latest)$'
    ))$new$);
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_proc where oid=v_target)
     <>'6fc776fbafa499cb646373c2d7b6fe7e' then
    raise exception 'Gemini upgrade verification failed; the transaction will roll back';
  end if;
end;
$upgrade$;
notify pgrst,'reload schema';
commit;
