-- ============================================================
-- Scanym V64 — Mot de passe oublié (dashboard) & numéro WhatsApp
--
-- Additif et idempotent (create or replace). N'exécuter qu'après
-- validation explicite. Aucune exécution automatique.
--
-- Périmètre strict :
--   • pas de modification des commandes ni de update_order_status ;
--   • pas de modification du parcours livraison / à emporter ;
--   • pas de Storage, super-admin ou back-office.
--
-- Note sur le mot de passe oublié : ce flux est intégralement géré
-- par Supabase Auth côté client (resetPasswordForEmail / updateUser).
-- Il ne modifie pas le modèle d'authentification (toujours e-mail +
-- mot de passe) et ne nécessite aucune fonction ni table SQL
-- supplémentaire. Rien à jouer ici pour cette partie.
-- ============================================================

-- ------------------------------------------------------------
-- Modification du numéro WhatsApp — réservée à owner et manager.
-- staff ne peut pas l'enregistrer (contrôle SQL, indépendant de
-- l'interface qui masque déjà le champ pour ce rôle).
--
-- restaurant_configs a déjà toute écriture directe révoquée pour
-- anon/authenticated depuis migration-v39-settings.sql : cette RPC
-- est donc la seule voie d'écriture, à l'image de
-- update_restaurant_settings.
-- ------------------------------------------------------------
create or replace function public.update_restaurant_whatsapp(
  p_restaurant_id   uuid,
  p_whatsapp_number text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trimmed  text;
  v_clean    text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = auth.uid()
      and ru.restaurant_id = p_restaurant_id
      and ru.role = any (array['owner', 'manager'])
  ) then
    raise exception using errcode = '42501',
      message = 'Not authorized for this restaurant';
  end if;

  v_trimmed := trim(coalesce(p_whatsapp_number, ''));

  if v_trimmed = '' then
    raise exception using errcode = '22023', message = 'WhatsApp number required';
  end if;

  if length(v_trimmed) > 50 then
    raise exception using errcode = '22023', message = 'WhatsApp number too long';
  end if;

  -- Normalisation identique à lib/whatsapp.ts (normalizeWhatsappNumber) :
  -- seuls les espaces et les tirets sont retirés (séparateurs de
  -- lisibilité légitimes). Une lettre ou une parenthèse n'est JAMAIS
  -- retirée silencieusement : le format doit rester "+213 550…", sans
  -- parenthèses, et une saisie comme "+213ABC666510901" doit être
  -- rejetée telle quelle, pas "réparée" en un numéro valide.
  v_clean := regexp_replace(v_trimmed, '[ \-]', '', 'g');

  -- Indicatif international obligatoire ('+'), puis 8 à 15 chiffres
  -- uniquement, sans zéro immédiatement après l'indicatif. Toute
  -- lettre ou parenthèse restante fait échouer ce test (elles n'ont
  -- pas été retirées ci-dessus). Même règle que lib/whatsapp.ts
  -- (isValidWhatsappNumber), à maintenir synchronisée.
  if v_clean !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using errcode = '22023',
      message = 'Invalid WhatsApp number format: expected + followed by 8 to 15 digits, no letters or parentheses';
  end if;

  update public.restaurant_configs
  set whatsapp_number = v_clean
  where restaurant_id = p_restaurant_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Restaurant not found';
  end if;
end $$;

revoke all on function public.update_restaurant_whatsapp(uuid, text) from public, anon;
grant execute on function public.update_restaurant_whatsapp(uuid, text) to authenticated;

-- ============================================================
-- TESTS À REJOUER MANUELLEMENT AVANT VALIDATION (non exécutés ici) :
--  ✗ staff modifie le numéro WhatsApp              → Not authorized
--  ✓ owner modifie le numéro WhatsApp              → OK, valeur persistée
--  ✓ manager modifie le numéro WhatsApp            → OK, valeur persistée
--  ✓ saisie avec espaces/tirets : "+213 550-00-00-00" → nettoyée en "+21355000000", acceptée
--  ✗ saisie avec parenthèses : "+213 (0) 550-00-00-00" → Invalid format (rejetée, pas nettoyée)
--  ✗ saisie avec lettres : "+213ABC666510901"       → Invalid format (rejetée, pas nettoyée)
--  ✗ numéro sans indicatif international ("0550…")  → Invalid format
--  ✗ numéro vide                                    → WhatsApp number required
--  ✗ numéro de plus de 50 caractères                → WhatsApp number too long
--  ✗ owner d'un autre restaurant                    → Not authorized
--  ✗ appel anonyme                                  → permission denied
--  ✓ migration rejouée deux fois (create or replace) → 0 erreur
-- ============================================================
