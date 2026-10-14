-- ============================================================================
-- MONETICO PAYMENT SIMULATOR v1.2 — TEST-PROJECT AUTHORITY v1 — ROLLBACK
-- Projet de TEST dédié uniquement. Restaure l'état antérieur : supprime
-- l'autorité, les jetons et leurs RPC ; RE-ACCORDE l'exécution des RPC
-- Stuart au rôle service_role (telle qu'accordée par leurs lots d'origine).
-- ============================================================================
do $$
begin
  if to_regclass('public.simulator_authority') is null then
    raise exception 'SCANYM_SCHEMA_DRIFT: public.simulator_authority absente -- rien à annuler.';
  end if;
end $$;

drop function if exists public.consume_simulator_decision_token(text, text, text, text);
drop function if exists public.issue_simulator_decision_token(text, text, text, text, text, integer);
drop function if exists public.get_simulator_authority();
drop table if exists public.simulator_decision_tokens;
drop table if exists public.simulator_authority;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'allocate_stuart_delivery_job',
        'mark_stuart_delivery_job_send_started',
        'confirm_stuart_delivery_job_created',
        'mark_stuart_delivery_job_ambiguous',
        'mark_stuart_delivery_job_terminal_failure'
      )
  loop
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
