-- =============================================================================
-- Scanym — RETURN TRACKING CAPABILITY v1 — ROLLBACK (DEVELOPMENT ONLY)
-- Supprime les capacités 'return' (les liens émis par la page de retour
-- cessent de fonctionner ; le lien legacy et les liens d'e-mail restent
-- valides), puis restaure les contraintes du lot v3.1.
-- =============================================================================

begin;

drop function public.issue_order_return_tracking_capability(uuid);

delete from public.order_tracking_capabilities where kind = 'return';

alter table public.order_tracking_capabilities
  drop constraint order_tracking_capabilities_email_bounded;
alter table public.order_tracking_capabilities
  add constraint order_tracking_capabilities_email_bounded
  check (
    (kind = 'email' and secret_hash is not null and expires_at is not null)
    or (kind = 'legacy_upgrade' and expires_at is null)
  );

alter table public.order_tracking_capabilities
  drop constraint order_tracking_capabilities_kind;
alter table public.order_tracking_capabilities
  add constraint order_tracking_capabilities_kind
  check (kind in ('legacy_upgrade', 'email'));

commit;
