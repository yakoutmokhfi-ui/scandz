-- ============================================================
-- Scanym — BULK PRODUCT PHOTOS v1.8
-- FINAL DURABLE CLEANUP STATE MACHINE
-- (Cat Stevens, réaudit indépendant de v1.7 -- verdict FAIL, 1 SEUL
-- finding release-blocking restant : claim_product_photo_pending_
-- cleanup marquait une ligne 'completed' AVANT que Storage.remove()
-- ait RÉELLEMENT réussi -- si la suppression Storage échouait ensuite,
-- la ligne pouvait rester consommée en 'completed' sans qu'aucune
-- récupération durable ne soit garantie (reopen_ jamais atteinte en
-- cas de crash, ou son propre échec/`{ error }` ignoré). Fermé par ce
-- fichier via une machine à états à 3 valeurs (PENDING -> PROCESSING
-- -> COMPLETED) avec bail (lease) expirant automatiquement ; TOUT le
-- reste de v1.3->v1.4->v1.5->v1.6->v1.7 reste fermé, PRÉSERVÉ TEL
-- QUEL, jamais redesigné -- voir CAT-STEVENS-FINDINGS-REMEDIATION.md)
-- DEVELOPMENT ONLY -- ce fichier ne doit être exécuté qu'après
-- validation Work/Cat Stevens/CIO, jamais directement sur Production
-- par ce lot.
--
-- Baseline requis : 3d38e791790e11235b01dfb2af564956f5b7ed55
-- (main courant, publié -- inclut Payment Operator Authorization v1,
-- Checkout Email Validation v1.1, Invoice Request Production
-- Prerequisite Remediation v1.3, Invoice Request Production ACL
-- Remediation v1 ; AUCUN de ces flux n'est touché par ce fichier).
--
-- ------------------------------------------------------------------
-- ADDENDUM v2.2 (BULK PRODUCT PHOTOS -- FINAL SIMPLIFICATION, décision
-- CIO : "confirming the Bulk import itself authorizes replacement",
-- plus de drapeau global ni de case par ligne -- une confirmation de
-- lot vaut autorisation de remplacement pour TOUT produit correctement
-- apparié de ce lot). ANNULE ET REMPLACE l'ADDENDUM v2.1 qui existait
-- ici (mécanisme `p_idempotency_key text default null` sur
-- apply_product_photo_replacement + colonne `menu_items.
-- photo_idempotency_key`) : v2.2 ferme le MÊME blocker technique
-- ("LOST HTTP RESPONSE / SUCCESSFUL REPLAY") par un mécanisme
-- DIFFÉRENT et STRICTEMENT CÔTÉ NODE (lib/server/product-photo-service.ts)
-- -- un chemin Storage DÉTERMINISTE, dérivé de restaurant_id (résolu
-- côté serveur) + product_id (résolu côté serveur) + batchId (opaque,
-- fourni par le client, un par lot Bulk), comparé à l'image
-- actuellement autoritaire (`begin_product_photo_replacement.
-- current_image_url`, déjà lue AVANT tout upload) -- AUCUNE requête
-- SQL supplémentaire, AUCUNE nouvelle colonne, AUCUN nouveau paramètre
-- n'est nécessaire pour cela. Le mécanisme v2.1 (colonne +
-- 5ème paramètre) est donc intégralement RETIRÉ ici -- ce fichier est
-- redevenu BYTE POUR BYTE identique à la forme v1.8/v2.0 déjà validée
-- (259/259 assertions du harnais SQL, FORWARD -> ROLLBACK -> FORWARD).
-- Voir DETERMINISTIC-BULK-PATH-IDEMPOTENCY.md (paquet v2.2) pour
-- l'analyse complète du nouveau mécanisme -- aucune ligne SQL n'est
-- modifiée par cet addendum, qui documente uniquement pourquoi.
-- NOTE (mise à jour v2.2.1 ci-dessous) : cette affirmation de parité
-- octet pour octet avec v1.8/v2.0 ne vaut plus que pour l'état ISSU DE
-- v2.2 seul -- ce fichier reçoit un delta SUPPLÉMENTAIRE, ciblé et
-- additif, par l'ADDENDUM v2.2.1 qui suit immédiatement.
-- ------------------------------------------------------------------
--
-- ------------------------------------------------------------------
-- ADDENDUM v2.2.1 (BULK PRODUCT PHOTOS -- FINAL RACE CONDITION FIX
-- ONLY / ONE FINDING ONLY -- Cat Stevens, réaudit final de v2.2,
-- SEUL blocker restant, tout le reste PASS et explicitement NON
-- REDESIGNÉ). Finding : la détection de conflit d'une relecture
-- ("retry") de l'ancien mécanisme Bulk (v2.2) s'appuyait sur une
-- lecture PRÉALABLE, NON VERROUILLÉE, de l'image courante
-- (`begin_product_photo_replacement.current_image_url`, lue AVANT
-- tout upload, donc AVANT toute tentative d'acquisition du verrou de
-- ligne autoritaire) -- une modification manuelle légitime (Single
-- Photo Edit) pouvait s'intercaler ENTRE cette lecture et l'obtention
-- ultérieure du verrou par apply_, et une relecture Bulk indéterminée
-- pouvait alors écraser SANS CONDITION la photo manuelle installée
-- entre-temps. UNLOCKED RETRY CHECK: YES -> NO (fermé ici).
--
-- Remédiation : la décision de relecture est déplacée ENTIÈREMENT dans
-- apply_product_photo_replacement, SOUS le verrou `for update` déjà
-- existant sur la ligne menu_items -- jamais avant, jamais via une
-- lecture Node séparée. Nouveau paramètre additif,
-- `p_is_retry boolean default false` (tout appelant existant qui
-- l'omet obtient un comportement STRICTEMENT inchangé, y compris
-- l'ordre exact des vérifications/erreurs -- 259/259 assertions
-- préexistantes du harnais SQL valides SANS AUCUNE modification).
-- Nouvelle colonne additive au retour, `already_applied boolean`.
--
-- Modèle strictement BINAIRE pour toute relecture (CIO "FINAL
-- SIMPLIFICATION", remplace intégralement le modèle à 3 cas A/B/C de
-- v2.2) : sous le verrou, SI l'image actuellement autoritaire égale
-- déjà la cible déterministe de ce lot Bulk (le paramètre
-- `p_new_image_url` existant, inchangé) -> ALREADY_APPLIED, retour
-- immédiat, AUCUNE mutation. SINON -> CONFLICT, nouvelle exception
-- SQLSTATE 'P0004' (précédent existant dans ce dépôt pour des
-- scénarios analogues de conflit de claim/bail -- voir
-- supabase/DRAFT-lot-payment-p3b-monetico-checkout-runtime-v46-forward.sql
-- et supabase/DRAFT-lot-payment-p3b5-durable-provider-callback-inbox.sql
-- -- grep-vérifié inutilisé ailleurs dans ce fichier avant cet ajout,
-- aucune collision), AUCUNE mutation. Jamais de troisième issue,
-- jamais une tentative d'inférer que la première requête a "sans
-- doute échoué" : une relecture indéterminée ne "continue" plus
-- jamais sous incertitude -- l'opérateur peut relancer explicitement
-- un nouveau Bulk si nécessaire.
--
-- La vérification d'existence de l'objet Storage (bloc juste avant le
-- verrou) est désormais conditionnée par `not p_is_retry` : une
-- relecture ne fait JAMAIS d'upload avant cet appel (invariant
-- "SECOND UPLOAD: NO" préservé sans condition, y compris exactement
-- dans le scénario de course mandaté), donc cette vérification
-- produirait sinon un troisième résultat (échec "not_found") qui
-- violerait le modèle binaire. La validation de FORME du chemin
-- (_product_photo_path_segments) reste, elle, INCONDITIONNELLE --
-- défense en profondeur peu coûteuse, cohérente avec le reste de ce
-- fichier, y compris pour une relecture.
--
-- CE QUI N'EST PAS FAIT (v2.2.1) : aucune nouvelle table, aucun
-- worker, aucune file d'attente, aucun redesign du nettoyage, aucun
-- redesign de bail, aucun redesign de Single Photo Edit -- strictement
-- un correctif de sérialisation/course sur apply_product_photo_replacement.
-- Toute la sémantique v2.2 explicitement confirmée PASS par Cat
-- Stevens (appariement déterministe, non-apparié, ambigu, conflit de
-- cible dupliquée, isolation tenant, produit croisé refusé, remplacement
-- de masse au premier Apply, idempotence de relecture après réponse
-- HTTP perdue, "replay check before upload: yes", Single Photo Edit,
-- architecture de nettoyage) reste PRÉSERVÉE SANS MODIFICATION.
-- ------------------------------------------------------------------
--
-- ------------------------------------------------------------------
-- CONTEXTE v1.3->v1.6 (PRÉSERVÉ, NON REDESIGNÉ -- résumé, voir
-- CAT-STEVENS-FINDINGS-REMEDIATION.md pour l'historique complet) :
--
-- v1.4 : set_product_photo supprimée -> begin_/apply_product_photo_
-- replacement, validation EXACTE du nouveau chemin, suppression
-- physique exclusivement API Storage réelle, contrat crypto.
-- randomUUID() exact, compensation upload/DB, verrouillage `for
-- update`. v1.5 : GRANT EXECUTE d'apply_ retiré à authenticated/anon/
-- public (service_role uniquement), assert_product_role_for
-- (jumeau paramétré), revalidation de FORME de l'ancienne valeur DB
-- avant nettoyage. v1.6 : revalidation ANCRÉE de l'ORIGINE (jamais
-- une recherche de sous-chaîne -- `starts_with` contre
-- p_expected_origin, calculée UNIQUEMENT côté serveur), retry de
-- nettoyage cleanup-only introduit (`retry_product_photo_cleanup_path`)
-- pour fermer le MEDIUM "cleanup failure not retriable". AUCUN de ces
-- points n'est modifié ICI -- voir "CE QUI N'EST PAS FAIT" plus bas.
--
-- ------------------------------------------------------------------
-- CONTEXTE v1.6->v1.7 (nouveaux findings Cat Stevens, fermés ICI) :
--
-- Blocker (v1.7, RELEASE-BLOCKING) -- LE RETRY DE NETTOYAGE ACCEPTAIT
-- UN oldPath FOURNI PAR LE CLIENT. `retry_product_photo_cleanup_path`
-- (v1.6) validait bien l'appartenance restaurant/produit, la FORME
-- (contrat UUID v4 exact) et l'inégalité avec l'image actuellement
-- autoritaire -- mais ne prouvait JAMAIS que le chemin candidat
-- correspondait à un échec de nettoyage RÉELLEMENT produit par le
-- flux de remplacement de confiance. Un appelant AUTORISÉ (le
-- propriétaire/gérant LÉGITIME de son propre produit -- aucune faille
-- cross-tenant requise) pouvait donc choisir arbitrairement un objet
-- **C** existant, non courant, sous le MÊME produit (par exemple un
-- ancien fichier jamais physiquement supprimé -- laissé par design,
-- voir STORAGE-API-CLEANUP-EVIDENCE.md) et le faire passer pour "mon
-- nettoyage en échec", provoquant une suppression Storage privilégiée
-- de cet objet C alors qu'aucun remplacement n'avait jamais
-- réellement échoué à le nettoyer. CLIENT SUPPLIES oldPath: YES ->
-- NO (fermé ici).
--
-- Remédiation (Blocker v1.7) : le client ne transmet PLUS JAMAIS de
-- chemin Storage, sous quelque forme que ce soit, à ce flux. Un
-- nouvel état durable, SERVEUR UNIQUEMENT,
-- `public.product_photo_pending_cleanups`, enregistre une preuve
-- qu'un nettoyage a RÉELLEMENT échoué, créée EXCLUSIVEMENT par le
-- serveur de confiance (jamais par le client, jamais par une RPC
-- accessible à authenticated/anon/PUBLIC) immédiatement après un
-- échec RÉEL de `Storage.remove()` consécutif à un
-- `apply_product_photo_replacement` RÉUSSI -- jamais avant, jamais
-- sur une simple demande. Le navigateur ne reçoit et ne retransmet
-- plus qu'un identifiant OPAQUE, `cleanup_id` (uuid généré serveur,
-- `gen_random_uuid()`) -- jamais interprété comme une autorisation en
-- lui-même (mandat : "cleanup id is not authorization") : chaque
-- retry réautorise l'appelant (assert_product_role_for, comme
-- apply_), résout la ligne par id, vérifie son appartenance EXACTE
-- (restaurant_id ET product_id), son statut ('pending' uniquement --
-- jamais un remplai d'un nettoyage déjà 'completed'), REVALIDE
-- (défense en profondeur -- jamais une confiance aveugle en la
-- validation faite à la création) la FORME du chemin stocké ET son
-- inégalité avec l'image actuellement autoritaire (relue fraîche),
-- puis SEULEMENT ALORS "réclame" (claim) atomiquement la ligne
-- (transition pending -> completed en une seule instruction UPDATE
-- conditionnelle, sous verrou `for update`) avant de renvoyer le
-- chemin comme sûr -- garantissant qu'au plus un retry concurrent
-- peut effectivement obtenir le feu vert pour un `cleanup_id` donné
-- (mandat item 19). Si la suppression Storage réelle (Node, hors de
-- cette transaction SQL) échoue malgré tout, Node rouvre EXPLICITEMENT
-- la ligne (pending -> completed annulé, retour à 'pending') via une
-- fonction dédiée, `reopen_product_photo_pending_cleanup` -- jamais un
-- second appel de création, jamais un nouvel identifiant.
--
-- Blocker (v1.7, RELEASE-BLOCKING, directement lié) -- COUVERTURE DE
-- HARNAIS INCORRECTE. Le harnais v1.6 traitait tout chemin candidat
-- conforme au restaurant/produit visés (et distinct de l'image
-- courante) comme une cible de retry LÉGITIME, sans jamais prouver
-- qu'un nettoyage avait RÉELLEMENT échoué pour ce chemin précis --
-- c'est exactement le défaut de conception que le Blocker ci-dessus
-- ferme. Fermé (harnais, hors de ce fichier SQL) : voir
-- supabase/tests/v67c-storage-operator-authorization-check.sh,
-- section v1.7 -- cycle de vie complet pending-cleanup (création
-- authentique uniquement après échec réel), objet C non lié (même
-- produit, chemin par ailleurs conforme, JAMAIS ciblé faute de
-- cleanup_id authentique le référençant), cleanup_id fabriqué/
-- inexistant/rejoué/cross-tenant/cross-produit, concurrence, defense
-- in depth (revalidation avant chaque remove()).
--
-- MEDIUM (v1.7) -- AUCUN TEST NODE/DOM SUBSTANTIEL POUR LE RETRY DE
-- NETTOYAGE. Fermé hors de ce fichier SQL -- voir
-- tests/v153-cleanup-retry-dom.test.ts (comportement RÉEL en DOM,
-- jamais un simple mock/export stub) et
-- tests/v152-product-photo-service.test.ts (mocks RPC précis pour
-- create_/claim_/reopen_product_photo_pending_cleanup).
--
-- ------------------------------------------------------------------
-- CONTEXTE v1.7->v1.8 (nouveau finding Cat Stevens, fermé ICI) :
--
-- Blocker (v1.8, RELEASE-BLOCKING, SEUL restant) -- CLAIM MARQUAIT
-- 'completed' AVANT LA SUPPRESSION STORAGE RÉELLE.
-- claim_product_photo_pending_cleanup (v1.7) transitionnait
-- pending -> completed de façon ATOMIQUE côté SQL -- mais cette
-- transition précédait TOUJOURS l'appel Storage.remove() réel côté
-- Node (hors de cette transaction SQL par nécessité -- Storage n'est
-- jamais transactionnel avec PostgreSQL). Si Storage.remove() échouait
-- ENSUITE : reopen_product_photo_pending_cleanup (v1.7) était appelée
-- en best-effort (try/catch) -- mais (a) un crash serveur survenu
-- APRÈS le claim mais AVANT reopen_ laissait la ligne 'completed' à
-- jamais, alors qu'aucune suppression physique n'avait eu lieu ; (b) un
-- échec/rejet de reopen_ elle-même (exception réseau/transport) était
-- avalé par le catch, sans aucune récupération ; (c) un résultat
-- Supabase `{ error }` normal (sans exception JS) renvoyé par reopen_
-- n'était JAMAIS vérifié -- le code appelait `await admin.rpc(...)`
-- sans jamais déstructurer/inspecter `.error`. Dans les trois cas :
-- un objet Storage non supprimé pouvait perdre TOUTE autorité de
-- retry durable, en silence. CLAIM MARKS COMPLETED BEFORE STORAGE
-- DELETE: YES -> NO (fermé ici).
--
-- Remédiation (Blocker v1.8) : la table gagne un état intermédiaire,
-- PROCESSING, avec un bail (lease) à expiration automatique. claim_ ne
-- transitionne plus JAMAIS vers 'completed' -- uniquement vers
-- 'processing' (pending -> processing, OU processing-bail-expiré ->
-- processing -- récupération automatique d'un claim abandonné, SANS
-- appel explicite requis). COMPLETED n'est désormais atteint QUE par
-- une NOUVELLE fonction dédiée, finalize_product_photo_pending_cleanup,
-- appelée EXCLUSIVEMENT après le succès RÉEL et CONFIRMÉ de
-- Storage.remove() côté Node. Si Storage.remove() échoue : une NOUVELLE
-- fonction, release_product_photo_pending_cleanup, ramène IMMÉDIATEMENT
-- la ligne à 'pending' pour un retry sans attendre -- mais, PAR
-- CONCEPTION, cet appel n'est JAMAIS l'UNIQUE garantie de récupération
-- (mandat : "no reopen-or-die design") : que release_ réussisse,
-- lève une exception, ou renvoie `{ error }`, la ligne 'processing'
-- redevient de toute façon réclamable AUTOMATIQUEMENT dès l'expiration
-- de son bail (lease_until), sans dépendre d'aucun appel applicatif
-- supplémentaire -- y compris en cas de crash serveur survenu N'IMPORTE
-- OÙ entre le claim et la finalisation. Node vérifie désormais
-- EXPLICITEMENT les DEUX formes d'échec (exception JS ET `{ error }`
-- Supabase normal) pour finalize_/release_ -- aucune n'est plus jamais
-- ignorée, même si aucune des deux ne conditionne plus la durabilité
-- du retry (garantie par le bail lui-même, jamais par cette
-- vérification seule).
--
-- ------------------------------------------------------------------
-- MODÈLE DE CONFIANCE v1.8 (étend, ne remplace pas, les modèles
-- v1.4/v1.5/v1.6/v1.7) :
--
--   1. begin_product_photo_replacement -- INCHANGÉE (v1.6). Toujours
--      la SEULE fonction AS-USER authentifiée du flux.
--
--   2. apply_product_photo_replacement -- INCHANGÉE (v1.6, y compris
--      p_expected_origin). Toujours la SEULE fonction qui écrit
--      menu_items.image_url, service_role uniquement.
--
--   3. public.assert_product_role_for -- INCHANGÉE (v1.5).
--
--   4. public._product_photo_path_segments -- INCHANGÉE (v1.6, origine
--      ANCRÉE). Réutilisée ICI pour relire/extraire fraîchement
--      l'image ACTUELLEMENT autoritaire au moment du claim (jamais une
--      valeur mise en cache).
--
--   5. public._product_photo_relative_path_shape -- INCHANGÉE (v1.6).
--      Réutilisée ICI pour la revalidation EN PROFONDEUR (defense in
--      depth) du chemin STOCKÉ dans product_photo_pending_cleanups, à
--      la fois à la création ET à chaque tentative de claim -- jamais
--      supposé immuable une fois écrit.
--
--   6. public.product_photo_pending_cleanups -- NOUVELLE TABLE (v1.7),
--      ÉTENDUE (v1.8). Unique état durable de ce lot. AUCUN accès
--      PUBLIC/anon/authenticated, sous AUCUNE forme (RLS activée SANS
--      AUCUNE policy -- refus par défaut -- ET REVOKE ALL explicite sur
--      la table elle-même ; seul service_role reçoit SELECT/INSERT/
--      UPDATE, JAMAIS DELETE -- une ligne 'completed' reste comme
--      trace d'audit, jamais effacée). Colonnes : id (uuid, clé
--      primaire, gen_random_uuid()), restaurant_id, product_id,
--      old_path (le chemin RELATIF déjà validé par apply_ -- jamais
--      une URL brute), status ('pending'|'processing'|'completed' --
--      'processing' NOUVEAU v1.8), claim_token (uuid, NOUVEAU v1.8 --
--      SERVEUR UNIQUEMENT, jamais transmis au navigateur), claimed_at/
--      lease_until (NOUVEAU v1.8 -- bail à expiration automatique),
--      attempt_count (NOUVEAU v1.8 -- traçabilité), created_at,
--      completed_at.
--
--   7. public.create_product_photo_pending_cleanup -- NOUVELLE
--      fonction (v1.7), service_role uniquement. Appelée
--      EXCLUSIVEMENT par Node, EXCLUSIVEMENT immédiatement après un
--      échec RÉEL de Storage.remove() sur le old_path DÉJÀ validé par
--      apply_ dans LA MÊME requête (jamais une valeur reconstruite,
--      jamais transmise par le navigateur à un quelconque moment) --
--      réautorise (assert_product_role_for), revalide la FORME du
--      chemin (defense in depth), insère la ligne 'pending', renvoie
--      son id.
--
--   8. public.claim_product_photo_pending_cleanup -- NOUVELLE fonction
--      (v1.7, remplace retry_product_photo_cleanup_path), RÉÉCRITE
--      (v1.8), service_role uniquement. Reçoit p_cleanup_id (uuid) --
--      JAMAIS un chemin. Réautorise, résout la ligne par id SOUS
--      VERROU (`for update`), vérifie appartenance EXACTE restaurant/
--      produit, REVALIDE la forme du chemin stocké ET son inégalité
--      avec l'image actuellement autoritaire (relue fraîche) --
--      INCHANGÉ depuis v1.7 pour ces vérifications. NOUVEAU v1.8 :
--      réclamable si status='pending' OU (status='processing' ET
--      lease_until < now() -- bail expiré) ; JAMAIS si 'completed' ;
--      JAMAIS si 'processing' avec bail encore valide. Transitionne
--      ATOMIQUEMENT (UPDATE ... WHERE (pending OU processing-bail-
--      expiré)) vers 'processing' -- JAMAIS vers 'completed' (c'est
--      exactement le défaut fermé par v1.8) -- pose claimed_at/
--      lease_until (p_lease_seconds, défaut 120s) et émet un NOUVEAU
--      claim_token (uuid). Renvoie `table(old_path, claim_token)` -- un
--      ENSEMBLE VIDE (jamais NULL scalaire) dans TOUS les cas de refus,
--      sans distinction observable entre eux (seule l'autorisation
--      elle-même -- assert_product_role_for -- lève une exception
--      distincte, comme apply_).
--
--   9. public.finalize_product_photo_pending_cleanup -- NOUVELLE
--      fonction (v1.8), service_role uniquement. Appelée EXCLUSIVEMENT
--      par Node, EXCLUSIVEMENT après le succès RÉEL et CONFIRMÉ de
--      Storage.remove() pour la ligne réclamée par un claim_ précédent.
--      SEULE fonction de ce lot qui transitionne une ligne vers
--      'completed' -- exige le claim_token EXACT renvoyé par ce claim_
--      (WHERE status='processing' AND claim_token=p_claim_token) : un
--      appel tardif dont le bail a expiré et dont la ligne a été
--      reréclamée par une tentative plus récente échoue silencieusement
--      (0 ligne, renvoie false) plutôt que d'écraser un état plus
--      récent.
--
--  10. public.release_product_photo_pending_cleanup -- NOUVELLE
--      fonction (v1.8, REMPLACE reopen_product_photo_pending_cleanup --
--      v1.7, dont la sémantique 'completed'->'pending' n'a plus de sens
--      une fois que claim_ ne transitionne plus jamais vers 'completed'
--      elle-même). service_role uniquement. Appelée EXCLUSIVEMENT par
--      Node, EXCLUSIVEMENT quand un claim_ a réussi (ligne 'processing')
--      MAIS que Storage.remove() a lui-même échoué -- ramène
--      IMMÉDIATEMENT la MÊME ligne à 'pending' (WHERE status=
--      'processing' AND claim_token=p_claim_token explicite), pour un
--      retry SANS attendre l'expiration du bail. NON-BLOQUANT PAR
--      CONCEPTION -- que cet appel réussisse, échoue, ou renvoie
--      `{ error }`, la ligne redevient de toute façon réclamable
--      automatiquement dès l'expiration du bail déjà posé par claim_
--      (mandat : "no reopen-or-die design" -- la durabilité du retry
--      n'a JAMAIS dépendu, et ne dépend toujours pas, du succès de
--      CETTE fonction).
--
-- CLIENT SUPPLIES oldPath: NO. CLIENT SUPPLIES cleanup_id: YES (identifiant
-- OPAQUE uniquement, jamais interprété comme une autorisation --
-- mandat "cleanup id is not authorization", voir claim_ ci-dessus).
-- CLIENT SUPPLIES claim_token: NO (SERVEUR UNIQUEMENT -- ne quitte
-- jamais lib/server/product-photo-service.ts, jamais sérialisé dans
-- une réponse HTTP). SERVER RESOLVES CLEANUP TARGET FROM DURABLE
-- STATE: YES. CLIENT CAN CREATE A PENDING CLEANUP RECORD: NO. CLIENT
-- CAN RETARGET A CLEANUP RECORD TO ANOTHER PATH: NO (aucune fonction de
-- ce lot n'accepte de chemin en paramètre depuis un contexte accessible
-- au client -- ni claim_, ni finalize_, ni release_). PENDING CLEANUP
-- CREATED ONLY AFTER A GENUINE REPLACEMENT + GENUINE STORAGE FAILURE:
-- YES. CLAIM MARKS COMPLETED BEFORE STORAGE DELETE: NO (v1.8 -- SEUL
-- blocker fermé par ce lot). PROCESSING LEASE: YES, EXPIRES
-- AUTOMATICALLY, NO EXPLICIT CALL REQUIRED FOR RECOVERY.
--
-- ------------------------------------------------------------------
-- POLICIES storage.objects -- AUCUN CHANGEMENT (re-vérifiées v1.7,
-- toujours `using (false)`/`with check (false)` pour authenticated,
-- aucun octroi anon). Voir STORAGE-POLICY-MATRIX.md.
--
-- ------------------------------------------------------------------
-- CE QUI N'EST PAS FAIT :
--   - Aucune modification de la suppression physique (API Storage
--     réelle exclusivement, Blocker 2 v1.4 -- PRÉSERVÉ).
--   - Aucune modification du contrat UUID v4 exact (Blocker 3 v1.4 --
--     PRÉSERVÉ).
--   - Aucune modification de la compensation orpheline
--     upload/échec-DB (MEDIUM 1 v1.4 -- PRÉSERVÉ).
--   - Aucune modification de la sérialisation `for update` dans
--     apply_ (MEDIUM 2 v1.4 -- PRÉSERVÉE).
--   - Aucune modification du GRANT/de la privilège d'apply_ (Blocker 1
--     v1.5 -- PRÉSERVÉ, service_role uniquement).
--   - Aucune modification de la revalidation de FORME (v1.5) ni de
--     l'ancrage d'ORIGINE (v1.6) de _product_photo_path_segments --
--     PRÉSERVÉES telles quelles, réutilisées SANS modification par ce
--     lot.
--   - Aucune modification de assert_product_role, assert_product_role_for,
--     begin_product_photo_replacement, apply_product_photo_replacement,
--     is_scanym_operator, get_merchant_catalogue, ou de tout autre RPC
--     catalogue -- réutilisées TELLES QUELLES.
--   - `retry_product_photo_cleanup_path` (v1.6) reste SUPPRIMÉE, jamais
--     réutilisée sous ce nom ni sous une signature compatible --
--     c'était le vecteur exact du Blocker fermé en v1.7.
--   - `reopen_product_photo_pending_cleanup` (v1.7) est SUPPRIMÉE --
--     REMPLACÉE par `finalize_`/`release_product_photo_pending_cleanup`
--     (v1.8, voir ci-dessus) -- sa sémantique ('completed' -> 'pending')
--     n'a plus de sens une fois que `claim_` ne transitionne plus
--     jamais vers 'completed' elle-même.
--   - claim_/finalize_/release_/create_product_photo_pending_cleanup
--     N'EFFECTUENT JAMAIS de suppression Storage elles-mêmes -- la
--     suppression physique reste, comme partout ailleurs dans ce lot,
--     exclusivement Node/API Storage réelle.
--   - Aucun balayage de nettoyage en arrière-plan n'est ajouté par
--     v1.8 -- l'expiration du bail (lease_until) rend une ligne
--     'processing' abandonnée réclamable par le PROCHAIN retry
--     déclenché par l'utilisateur, jamais par un worker/cron
--     autonome (hors périmètre du plus petit changement sûr, comme en
--     v1.6).
--   - Aucun ajout de balayage de nettoyage en arrière-plan (pas de
--     cron/scheduled cleanup sweep -- retry reste explicitement
--     déclenché par l'utilisateur, comme v1.6).
--   - Aucun DELETE n'est jamais exécuté sur product_photo_pending_
--     cleanups par ce lot -- une ligne 'completed' est conservée comme
--     trace d'audit (mandat : champs `status`, `completed_at`).
--   - Aucun fichier Invoice/Payment/Checkout touché.
-- ============================================================


-- ------------------------------------------------------------------
-- 0. CONTRÔLE PRÉALABLE DE NON-DÉRIVE DU SCHÉMA (lecture seule, avant
--    toute transaction -- si ce bloc échoue, rien n'a encore été
--    touché).
-- ------------------------------------------------------------------
do $$
begin
  if (
    select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in (
        'product_photos_select_own_restaurant',
        'product_photos_insert_own_restaurant',
        'product_photos_update_own_restaurant',
        'product_photos_delete_own_restaurant'
      )
  ) <> 4 then
    raise exception
      'SCANYM_SCHEMA_DRIFT: les 4 policies product_photos_%% attendues sont introuvables -- migration annulée, rien modifié.';
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_scanym_operator'
      and pg_get_function_identity_arguments(p.oid) = ''
      and pg_get_function_result(p.oid) = 'boolean'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.is_scanym_operator() introuvable avec la signature attendue -- migration annulée.';
  end if;

  if not exists (select 1 from storage.buckets where id = 'product-photos') then
    raise exception
      'SCANYM_SCHEMA_DRIFT: bucket product-photos introuvable -- migration V67 non appliquée, annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'category_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'archived_at'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_items' and column_name = 'image_url'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.menu_items ne correspond pas au contrat attendu (id/category_id/archived_at/image_url) -- migration annulée.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'menu_categories' and column_name = 'restaurant_id'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.menu_categories ne correspond pas au contrat attendu (id/restaurant_id) -- migration annulée.';
  end if;

  -- 0f. La fonction set_product_photo v1.3 (avec sa capture v_old_url)
  -- doit exister -- confirme que le baseline est bien v1.3, jamais V67
  -- brut ni une double-application de ce fichier. Ce fichier reste,
  -- comme en v1.4/v1.5/v1.6, une migration CUMULATIVE depuis V67 --
  -- jamais un delta relatif à un état v1.4/v1.5/v1.6 déjà installé
  -- (voir harnais SQL, qui réinjecte l'état intermédiaire v1.3 par
  -- heredoc avant d'appliquer ce fichier réel depuis le disque).
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_product_photo'
      and pg_get_function_identity_arguments(p.oid) = 'p_product_id uuid, p_image_url text'
      and pg_get_functiondef(p.oid) like '%v_old_url%'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.set_product_photo(uuid, text) v1.3 (avec capture v_old_url) introuvable -- baseline v1.3 attendu, migration annulée.';
  end if;

  -- 0g. Aucune des fonctions v1.4/v1.5/v1.6/v1.7/v1.8 ne doit déjà
  -- exister (évite une double-application silencieuse). Note :
  -- retry_product_photo_cleanup_path (v1.6) et
  -- reopen_product_photo_pending_cleanup (v1.7) ne sont PAS dans cette
  -- liste -- ce lot ne les recrée JAMAIS (reopen_ est REMPLACÉE par
  -- finalize_/release_ ci-dessous -- v1.8), leur non-existence
  -- éventuelle n'est donc jamais un signal de dérive pour CE fichier.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'begin_product_photo_replacement',
      'apply_product_photo_replacement',
      'assert_product_role_for',
      '_product_photo_path_segments',
      '_product_photo_relative_path_shape',
      'create_product_photo_pending_cleanup',
      'claim_product_photo_pending_cleanup',
      'finalize_product_photo_pending_cleanup',
      'release_product_photo_pending_cleanup'
    )
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: une ou plusieurs fonctions v1.4/v1.5/v1.6/v1.7/v1.8 existent déjà -- migration annulée pour éviter une double-application.';
  end if;

  -- 0h. product_photo_pending_cleanups ne doit pas déjà exister.
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'product_photo_pending_cleanups'
  ) then
    raise exception
      'SCANYM_SCHEMA_DRIFT: public.product_photo_pending_cleanups existe déjà -- migration annulée.';
  end if;

  -- 0i. service_role doit exister comme rôle PostgreSQL (requis pour
  -- le GRANT EXECUTE exclusif ci-dessous -- Blocker 1 v1.5, inchangé).
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception
      'SCANYM_SCHEMA_DRIFT: rôle service_role introuvable -- migration annulée.';
  end if;
end $$;

-- ------------------------------------------------------------------
-- 1. Transaction principale.
-- ------------------------------------------------------------------

begin;

-- ------------------------------------------------------------
-- 1a. set_product_photo(uuid, text) -- SUPPRIMÉE (v1.4, inchangé).
-- ------------------------------------------------------------

drop function public.set_product_photo(uuid, text);

-- ------------------------------------------------------------
-- 1b. public._product_photo_relative_path_shape -- INCHANGÉE (v1.6).
-- ------------------------------------------------------------

create function public._product_photo_relative_path_shape(
  p_restaurant_id uuid,
  p_product_id    uuid,
  p_relative_path text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_segments text[];
begin
  if p_relative_path is null then
    return null;
  end if;

  v_segments := string_to_array(p_relative_path, '/');
  if array_length(v_segments, 1) <> 3 then
    return null;
  end if;

  if v_segments[1] <> p_restaurant_id::text then
    return null;
  end if;

  if v_segments[2] <> p_product_id::text then
    return null;
  end if;

  -- Contrat EXACT crypto.randomUUID() v4 + extension autorisée
  -- (Blocker 3 v1.4, inchangé) : minuscules uniquement, version = '4'
  -- (13e caractère hex), variante RFC4122 in (8,9,a,b) (17e caractère
  -- hex). L'UUID nil est automatiquement rejeté (son 13e caractère
  -- hex est '0').
  if v_segments[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$' then
    return null;
  end if;

  return p_relative_path;
end $$;

revoke all on function public._product_photo_relative_path_shape(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public._product_photo_relative_path_shape(uuid, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 1c. public._product_photo_path_segments -- INCHANGÉE (v1.6, origine
-- ANCRÉE). Réutilisée par claim_product_photo_pending_cleanup
-- ci-dessous pour extraire fraîchement le chemin de l'image
-- ACTUELLEMENT autoritaire.
-- ------------------------------------------------------------

create function public._product_photo_path_segments(
  p_restaurant_id   uuid,
  p_product_id      uuid,
  p_image_url       text,
  p_expected_origin text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_expected_prefix text;
  v_path            text;
begin
  if p_image_url is null then
    return null;
  end if;

  if p_expected_origin is null or length(btrim(p_expected_origin)) = 0 then
    return null;
  end if;

  if length(p_image_url) > 2048 then
    return null;
  end if;

  v_expected_prefix := p_expected_origin || '/storage/v1/object/public/product-photos/';

  if not starts_with(p_image_url, v_expected_prefix) then
    return null;
  end if;

  v_path := substring(p_image_url from length(v_expected_prefix) + 1);

  return public._product_photo_relative_path_shape(p_restaurant_id, p_product_id, v_path);
end $$;

revoke all on function public._product_photo_path_segments(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public._product_photo_path_segments(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- 1d. public.assert_product_role_for -- INCHANGÉE (v1.5).
-- ------------------------------------------------------------

create function public.assert_product_role_for(
  p_caller_user_id uuid,
  p_product_id     uuid,
  p_roles          text[]
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
begin
  if p_caller_user_id is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  select mc.restaurant_id into v_restaurant_id
  from public.menu_items mi
  join public.menu_categories mc on mc.id = mi.category_id
  where mi.id = p_product_id;

  if v_restaurant_id is null then
    raise exception using errcode = 'P0002', message = 'Product not found';
  end if;

  if not exists (
    select 1 from public.restaurant_users ru
    where ru.user_id = p_caller_user_id
      and ru.restaurant_id = v_restaurant_id
      and ru.role = any (p_roles)
  ) and not exists (
    select 1 from public.scanym_operators so where so.user_id = p_caller_user_id
  ) then
    raise exception using errcode = '42501', message = 'Not authorized for this product';
  end if;

  return v_restaurant_id;
end $$;

revoke all on function public.assert_product_role_for(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.assert_product_role_for(uuid, uuid, text[]) to service_role;

-- ------------------------------------------------------------
-- 1e. begin_product_photo_replacement -- INCHANGÉE (v1.6).
-- ------------------------------------------------------------

create function public.begin_product_photo_replacement(
  p_product_id uuid
)
returns table(restaurant_id uuid, caller_user_id uuid, current_image_url text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant_id    uuid;
  v_current_image_url text;
begin
  v_restaurant_id := public.assert_product_role(p_product_id, array['owner','manager']);

  select mi.image_url into v_current_image_url
  from public.menu_items mi
  where mi.id = p_product_id and mi.archived_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found or archived';
  end if;

  return query select v_restaurant_id, auth.uid(), v_current_image_url;
end $$;

revoke all on function public.begin_product_photo_replacement(uuid) from public, anon;
grant execute on function public.begin_product_photo_replacement(uuid) to authenticated;

-- ------------------------------------------------------------
-- 1f. apply_product_photo_replacement -- v2.2.1 : ajoute
-- `p_is_retry boolean default false` (additif, rétro-compatible --
-- tout appelant existant qui omet ce paramètre obtient un
-- comportement STRICTEMENT identique octet pour octet, y compris
-- l'ordre exact des vérifications/erreurs). Voir ADDENDUM v2.2.1
-- en tête de fichier pour le blocker fermé et la justification
-- complète de chaque ligne ajoutée ci-dessous.
-- ------------------------------------------------------------

create function public.apply_product_photo_replacement(
  p_caller_user_id   uuid,
  p_product_id       uuid,
  p_new_image_url    text,
  p_expected_origin  text,
  p_is_retry         boolean default false
)
returns table(old_path text, image_url text, old_path_cleanup_skipped boolean, already_applied boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id          uuid;
  v_new_image_url          text;
  v_new_path               text;
  v_old_url                text;
  v_old_path               text;
  v_old_path_skipped       boolean := false;
begin
  v_restaurant_id := public.assert_product_role_for(p_caller_user_id, p_product_id, array['owner','manager']);

  if p_expected_origin is null or length(btrim(p_expected_origin)) = 0 then
    raise exception using errcode = '22023', message = 'Missing expected storage origin';
  end if;

  v_new_image_url := nullif(btrim(coalesce(p_new_image_url, ''), E' \t\n\r\f' || chr(11)), '');
  if v_new_image_url is not null and length(v_new_image_url) > 2048 then
    raise exception using errcode = '22023', message = 'Image URL too long';
  end if;

  if v_new_image_url is not null then
    -- Validation de FORME du chemin cible : inconditionnelle, y
    -- compris pour une relecture (p_is_retry=true) -- défense en
    -- profondeur peu coûteuse, jamais une confiance aveugle même en
    -- interne, cohérent avec le reste de ce fichier.
    v_new_path := public._product_photo_path_segments(v_restaurant_id, p_product_id, v_new_image_url, p_expected_origin);
    if v_new_path is null then
      raise exception using errcode = '22023', message = 'Invalid new image path: does not match the exact trusted path contract';
    end if;

    -- L'existence de l'objet Storage n'est vérifiée QUE pour un
    -- premier Apply : une relecture (p_is_retry=true) ne fait JAMAIS
    -- d'upload avant cet appel (invariant v2.2.1 "SECOND UPLOAD: NO"),
    -- donc cette vérification produirait un troisième résultat
    -- (échec "not_found") qui violerait le modèle strictement binaire
    -- ALREADY_APPLIED / CONFLICT exigé pour toute relecture.
    if not p_is_retry then
      if not exists (
        select 1 from storage.objects
        where bucket_id = 'product-photos' and name = v_new_path
      ) then
        raise exception using errcode = 'P0002', message = 'New image object does not exist in storage';
      end if;
    end if;
  end if;

  -- `menu_items.image_url` DOIT être qualifié par alias : la clause
  -- `returns table(old_path text, image_url text, ...)` de cette
  -- fonction introduit un paramètre OUT implicite lui-même nommé
  -- `image_url`, rendant toute référence NON qualifiée à `image_url`
  -- ambiguë entre ce paramètre et la colonne de table (PL/pgSQL lève
  -- ERROR 42702 -- détecté par exécution réelle, jamais supposé).
  select mi.image_url into v_old_url
  from public.menu_items mi
  where mi.id = p_product_id and mi.archived_at is null
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Product not found or archived';
  end if;

  -- v2.2.1 -- SOLE BLOCKER FIX : la décision de relecture (already
  -- applied vs conflict) est prise ICI, APRÈS l'acquisition du verrou
  -- de ligne ci-dessus (`for update`), sous la MÊME frontière de
  -- sérialisation que la mutation elle-même. Aucune lecture non
  -- verrouillée antérieure n'intervient dans cette décision -- il n'y
  -- a donc aucune fenêtre de course entre la comparaison et la
  -- décision autoritaire. Modèle strictement binaire (CIO "FINAL
  -- SIMPLIFICATION") : une relecture indéterminée n'est JAMAIS
  -- autorisée à "probablement" continuer -- soit l'image actuelle,
  -- SOUS VERROU, égale déjà la cible déterministe de ce lot Bulk
  -- (ALREADY_APPLIED, aucune mutation), soit elle diffère (CONFLICT,
  -- aucune mutation, l'opérateur peut relancer un nouveau Bulk).
  if p_is_retry then
    if v_old_url is not distinct from v_new_image_url then
      return query select null::text, v_new_image_url, false, true;
      return;
    else
      raise exception using errcode = 'P0004', message = 'Photo replacement conflict: authoritative current image does not match the deterministic retry target';
    end if;
  end if;

  update public.menu_items
  set image_url = v_new_image_url
  where id = p_product_id;

  if v_old_url is not null then
    v_old_path := public._product_photo_path_segments(v_restaurant_id, p_product_id, v_old_url, p_expected_origin);
    if v_old_path is null then
      v_old_path_skipped := true;
    elsif v_old_path = coalesce(v_new_path, '') then
      v_old_path := null;
    end if;
  end if;

  return query select v_old_path, v_new_image_url, v_old_path_skipped, false;
end $$;

revoke all on function public.apply_product_photo_replacement(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.apply_product_photo_replacement(uuid, uuid, text, text, boolean) to service_role;

-- ------------------------------------------------------------
-- 1g. public.product_photo_pending_cleanups -- NOUVELLE TABLE (v1.7).
-- Unique état durable de ce lot -- la SEULE preuve qu'un nettoyage a
-- RÉELLEMENT échoué, jamais une affirmation du client. AUCUN accès
-- PUBLIC/anon/authenticated sous AUCUNE forme -- RLS activée SANS
-- AUCUNE policy (refus par défaut pour tout rôle soumis à RLS) ET
-- REVOKE ALL explicite sur la table elle-même (défense en profondeur
-- -- les deux mécanismes, pas un seul). Seul service_role reçoit
-- SELECT/INSERT/UPDATE -- JAMAIS DELETE : une ligne 'completed' est
-- conservée comme trace d'audit (mandat : champs status/completed_at),
-- jamais effacée par ce lot.
-- ------------------------------------------------------------

create table public.product_photo_pending_cleanups (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  product_id    uuid not null,
  old_path      text not null,
  status        text not null default 'pending',
  -- NOUVEAU v1.8 -- état durable du bail (lease) de traitement. NULL
  -- tant que la ligne n'a jamais été réclamée (status='pending').
  -- claim_token : jeton OPAQUE (uuid), SERVEUR UNIQUEMENT -- jamais
  --   transmis au navigateur -- généré à CHAQUE claim_ réussi, requis
  --   par finalize_/release_ pour prouver qu'ils agissent bien sur LA
  --   MÊME tentative de claim qui l'a obtenu (empêche un claim_ tardif
  --   -- resté bloqué après expiration de son propre bail -- de
  --   finaliser/relâcher une ligne qu'un claim_ plus récent possède
  --   déjà légitimement).
  -- claimed_at : horodatage du dernier claim_ réussi.
  -- lease_until : le bail expire à cet instant -- au-delà, une ligne
  --   'processing' redevient réclamable par un NOUVEAU claim_ (mandat :
  --   "PROCESSING must NOT be able to become permanently stuck"),
  --   SANS dépendre d'un quelconque appel explicite de récupération.
  -- attempt_count : nombre total de claims réussis pour cette ligne --
  --   traçabilité/audit uniquement, jamais utilisé pour bloquer un
  --   retry (mandat n'impose aucune limite de tentatives).
  claim_token   uuid,
  claimed_at    timestamptz,
  lease_until   timestamptz,
  attempt_count integer not null default 0,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  -- NOUVEAU v1.8 -- 'processing' ajouté : COMPLETED ne doit plus JAMAIS
  -- être atteint avant que Storage.remove() ait RÉELLEMENT réussi
  -- (SEUL blocker de v1.7 fermé par ce lot -- voir finalize_
  -- ci-dessous). L'ancien état à 2 valeurs ('pending'|'completed') de
  -- v1.7 permettait à claim_ de marquer 'completed' AVANT la
  -- suppression Storage réelle -- c'est exactement le défaut fermé ici.
  constraint product_photo_pending_cleanups_status_check
    check (status in ('pending', 'processing', 'completed'))
);

-- NOUVEAU v1.8 -- accélère la sélection des lignes réclamables (status +
-- lease_until) par le futur balayage/observabilité éventuel -- jamais
-- utilisé par un chemin RLS/sécurité (la lecture reste service_role
-- uniquement, via claim_ elle-même, jamais un accès direct table).
create index product_photo_pending_cleanups_claimable_idx
  on public.product_photo_pending_cleanups (status, lease_until);

alter table public.product_photo_pending_cleanups enable row level security;
-- Volontairement AUCUNE policy créée -- RLS activée + zéro policy =
-- zéro accès pour tout rôle soumis à RLS (anon, authenticated).
-- service_role contourne RLS nativement (rôle de confiance côté
-- Supabase) -- ce comportement natif est ICI RENFORCÉ, jamais
-- remplacé, par le REVOKE/GRANT explicite ci-dessous.

revoke all on public.product_photo_pending_cleanups from public, anon, authenticated;
grant select, insert, update on public.product_photo_pending_cleanups to service_role;

-- ------------------------------------------------------------
-- 1h. public.create_product_photo_pending_cleanup -- NOUVELLE
-- fonction (v1.7), service_role uniquement, AUCUN accès client sous
-- aucune forme. Appelée EXCLUSIVEMENT par Node, EXCLUSIVEMENT
-- immédiatement après un échec RÉEL de Storage.remove() sur un
-- old_path DÉJÀ validé par apply_product_photo_replacement dans LA
-- MÊME requête serveur (jamais une valeur reconstruite, jamais
-- transmise par le navigateur à un quelconque moment de ce chemin).
-- Réautorise DE NOUVEAU (comme apply_/claim_ -- aucun droit hérité),
-- REVALIDE la FORME du chemin (defense in depth -- jamais une
-- confiance aveugle dans l'appelant, même interne) avant d'insérer.
-- ------------------------------------------------------------

create function public.create_product_photo_pending_cleanup(
  p_caller_user_id   uuid,
  p_product_id       uuid,
  p_old_path         text,
  p_expected_origin  text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id  uuid;
  v_validated_path text;
  v_id             uuid;
begin
  v_restaurant_id := public.assert_product_role_for(p_caller_user_id, p_product_id, array['owner','manager']);

  if p_expected_origin is null or length(btrim(p_expected_origin)) = 0 then
    raise exception using errcode = '22023', message = 'Missing expected storage origin';
  end if;

  -- Defense in depth -- ce chemin a DÉJÀ été validé une fois par
  -- apply_ dans la même requête serveur, mais cette fonction ne fait
  -- JAMAIS confiance à cette hypothèse : une forme invalide ici
  -- indique un défaut interne (jamais un vecteur client, cette
  -- fonction n'étant accessible qu'en service_role), refusée
  -- explicitement plutôt que silencieusement acceptée.
  v_validated_path := public._product_photo_relative_path_shape(v_restaurant_id, p_product_id, p_old_path);
  if v_validated_path is null then
    raise exception using errcode = '22023', message = 'Invalid old path: does not match the exact trusted path contract';
  end if;

  insert into public.product_photo_pending_cleanups (restaurant_id, product_id, old_path, status)
  values (v_restaurant_id, p_product_id, v_validated_path, 'pending')
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.create_product_photo_pending_cleanup(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_product_photo_pending_cleanup(uuid, uuid, text, text) to service_role;

-- ------------------------------------------------------------
-- 1i. public.claim_product_photo_pending_cleanup -- RÉÉCRITE v1.8
-- (SEUL blocker de v1.7 fermé par ce lot -- v1.7 transitionnait
-- pending -> COMPLETED ICI, AVANT que Storage.remove() ait réellement
-- réussi ; voir CLEANUP-STATE-MACHINE.md). Transitionne désormais
-- EXCLUSIVEMENT pending -> PROCESSING (JAMAIS -> completed). AUCUNE
-- suppression Storage elle-même -- toujours une fonction de VALIDATION
-- + RÉCLAMATION ATOMIQUE uniquement, service_role exclusivement.
--
-- p_cleanup_id est un identifiant OPAQUE (uuid) -- JAMAIS un chemin,
-- JAMAIS interprété comme une autorisation en lui-même (mandat :
-- "cleanup id is not authorization", inchangé depuis v1.7) : réautorise
-- DE NOUVEAU (assert_product_role_for), résout la ligne SOUS VERROU
-- (`for update`), vérifie l'appartenance EXACTE (restaurant_id ET
-- product_id résolus pour CET appelant/produit), REVALIDE la FORME du
-- chemin STOCKÉ (defense in depth) ET son inégalité avec l'image
-- ACTUELLEMENT autoritaire (relue fraîche) -- INCHANGÉ depuis v1.7 pour
-- ces cinq vérifications.
--
-- NOUVEAU v1.8 -- une ligne est RÉCLAMABLE (claimable) si et seulement
-- si : status='pending', OU status='processing' ET lease_until < now()
-- (bail expiré -- mandat : "A cleanup is claimable when: status =
-- PENDING OR status = PROCESSING AND lease_until < now()"). Une ligne
-- 'processing' dont le bail est encore VALIDE n'est JAMAIS réclamable
-- par un second appelant (mandat item 09 -- concurrence). Une ligne
-- 'completed' n'est JAMAIS réclamable, quel que soit lease_until.
--
-- Réclamation ATOMIQUE -- UPDATE ... WHERE (status='pending' OR
-- (status='processing' AND lease_until < now())) RETURNING old_path,
-- claim_token : au plus UN appelant concurrent peut réussir cette
-- réclamation pour un cleanup_id donné, le verrou `for update` posé
-- par le SELECT initial sérialisant déjà tout concurrent avant même
-- cette UPDATE (mandat item 09/10). Un NOUVEAU claim_token (uuid,
-- gen_random_uuid()) est émis à CHAQUE claim réussi -- y compris un
-- claim qui récupère un bail expiré abandonné par un appelant
-- précédent -- de sorte qu'un appelant précédent, tardivement
-- réveillé après l'expiration de SON PROPRE bail, ne puisse plus
-- jamais finaliser/relâcher une ligne qu'un claim plus récent possède
-- désormais légitimement (finalize_/release_ ci-dessous exigent une
-- correspondance EXACTE de claim_token). attempt_count est incrémenté
-- à chaque claim réussi (traçabilité uniquement).
--
-- Renvoie un ENSEMBLE VIDE (0 ligne, jamais NULL comme scalaire -- le
-- type de retour devient `table(old_path text, claim_token uuid)`)
-- dans TOUS les cas de refus (id fabriqué/inexistant, 'completed',
-- 'processing' avec bail encore valide, mauvais restaurant/produit,
-- forme invalide, cible l'image courante, course perdue) -- AUCUNE
-- distinction observable entre ces cas côté forme du résultat (seule
-- une autorisation totalement absente -- assert_product_role_for --
-- lève une exception distincte, comme apply_/create_), inchangé depuis
-- v1.7.
-- ------------------------------------------------------------

create function public.claim_product_photo_pending_cleanup(
  p_caller_user_id   uuid,
  p_product_id       uuid,
  p_cleanup_id       uuid,
  p_expected_origin  text,
  p_lease_seconds    integer default 120
)
returns table(old_path text, claim_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id      uuid;
  v_row                public.product_photo_pending_cleanups%rowtype;
  v_reverified_path    text;
  v_current_image_url  text;
  v_current_path       text;
  v_new_token          uuid;
begin
  v_restaurant_id := public.assert_product_role_for(p_caller_user_id, p_product_id, array['owner','manager']);

  if p_expected_origin is null or length(btrim(p_expected_origin)) = 0 then
    return;
  end if;

  if p_cleanup_id is null then
    return;
  end if;

  if p_lease_seconds is null or p_lease_seconds <= 0 then
    p_lease_seconds := 120;
  end if;

  select * into v_row
  from public.product_photo_pending_cleanups
  where id = p_cleanup_id
  for update;

  if not found then
    -- cleanup_id fabriqué/inexistant -- jamais distingué d'un autre
    -- refus côté forme du résultat.
    return;
  end if;

  if v_row.status = 'completed' then
    -- JAMAIS réclamable -- Storage.remove() a déjà RÉELLEMENT réussi
    -- pour cette ligne (mandat item 11 -- "completed cleanup retry: no
    -- second effective delete").
    return;
  end if;

  if v_row.status = 'processing' and v_row.lease_until is not null and v_row.lease_until >= now() then
    -- Bail (lease) encore VALIDE, détenu par une autre tentative en
    -- cours -- JAMAIS réclamable tant que ce bail n'a pas expiré
    -- (mandat item 09 -- concurrence).
    return;
  end if;

  if v_row.restaurant_id <> v_restaurant_id or v_row.product_id <> p_product_id then
    -- Ligne réelle, mais n'appartient PAS EXACTEMENT au restaurant/
    -- produit résolus pour CET appelant -- jamais cross-tenant/
    -- cross-produit.
    return;
  end if;

  -- Defense in depth -- revalide la FORME du chemin STOCKÉ à CHAQUE
  -- tentative de claim, jamais supposée immuable depuis sa création.
  v_reverified_path := public._product_photo_relative_path_shape(v_row.restaurant_id, v_row.product_id, v_row.old_path);
  if v_reverified_path is null then
    return;
  end if;

  -- Ne réclame JAMAIS un chemin correspondant à l'image ACTUELLEMENT
  -- autoritaire -- relue fraîche, jamais transmise par le client.
  select mi.image_url into v_current_image_url
  from public.menu_items mi
  where mi.id = p_product_id and mi.archived_at is null;

  if v_current_image_url is not null then
    v_current_path := public._product_photo_path_segments(v_row.restaurant_id, v_row.product_id, v_current_image_url, p_expected_origin);
    if v_current_path is not null and v_current_path = v_reverified_path then
      return;
    end if;
  end if;

  v_new_token := gen_random_uuid();

  -- Réclamation ATOMIQUE -- transition (pending OU processing-bail-
  -- expiré) -> PROCESSING en UNE seule instruction conditionnelle,
  -- JAMAIS -> completed (c'est exactement le défaut fermé par v1.8).
  -- Le verrou `for update` posé par le SELECT ci-dessus sérialise déjà
  -- tout claim concurrent pour ce MÊME cleanup_id ; cette clause WHERE
  -- reste un garde-fou explicite supplémentaire.
  update public.product_photo_pending_cleanups
  set status = 'processing',
      claimed_at = now(),
      lease_until = now() + make_interval(secs => p_lease_seconds),
      claim_token = v_new_token,
      attempt_count = attempt_count + 1
  where id = p_cleanup_id
    and (status = 'pending' or (status = 'processing' and lease_until < now()));

  if not found then
    -- Course perdue entre le SELECT ... FOR UPDATE et cette UPDATE
    -- (théoriquement impossible sous le verrou déjà posé -- garde-fou
    -- défensif, jamais observé).
    return;
  end if;

  return query select v_reverified_path, v_new_token;
end $$;

revoke all on function public.claim_product_photo_pending_cleanup(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_product_photo_pending_cleanup(uuid, uuid, uuid, text, integer) to service_role;

-- ------------------------------------------------------------
-- 1j. public.finalize_product_photo_pending_cleanup -- NOUVELLE
-- fonction (v1.8). service_role uniquement. Appelée EXCLUSIVEMENT par
-- Node, EXCLUSIVEMENT après que Storage.remove(old_path) a RÉELLEMENT
-- réussi (hors de cette transaction SQL, toujours côté Node) pour la
-- ligne réclamée par un claim_ précédent -- SEULE fonction de ce lot
-- qui transitionne une ligne vers 'completed'. Exige EXACTEMENT le
-- claim_token renvoyé par ce claim_ précédent (SERVEUR UNIQUEMENT,
-- jamais transmis au navigateur) -- si un AUTRE claim (bail expiré
-- entre-temps, réclamé par une tentative plus récente) possède
-- désormais la ligne, cette finalisation tardive échoue silencieusement
-- (0 ligne affectée, renvoie false) plutôt que d'écraser un état plus
-- récent. Idempotence : Storage.remove() sur un chemin déjà absent
-- n'est JAMAIS une erreur côté API Storage réelle (suppression
-- S3-compatible, sémantiquement idempotente) -- un retry après un crash
-- survenu APRÈS un Storage.remove() réussi mais AVANT cette finalisation
-- réclame la ligne DE NOUVEAU (bail expiré), retente Storage.remove()
-- (no-op sûr, objet déjà absent), puis finalise normalement -- jamais
-- de recréation d'objet, jamais de modification de l'image courante.
-- ------------------------------------------------------------

create function public.finalize_product_photo_pending_cleanup(
  p_caller_user_id uuid,
  p_product_id     uuid,
  p_cleanup_id     uuid,
  p_claim_token    uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_finalized     boolean;
begin
  v_restaurant_id := public.assert_product_role_for(p_caller_user_id, p_product_id, array['owner','manager']);

  if p_claim_token is null then
    return false;
  end if;

  update public.product_photo_pending_cleanups
  set status = 'completed', completed_at = now()
  where id = p_cleanup_id
    and restaurant_id = v_restaurant_id
    and product_id = p_product_id
    and status = 'processing'
    and claim_token = p_claim_token
  returning true into v_finalized;

  return coalesce(v_finalized, false);
end $$;

revoke all on function public.finalize_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 1k. public.release_product_photo_pending_cleanup -- NOUVELLE
-- fonction (v1.8, REMPLACE reopen_product_photo_pending_cleanup --
-- v1.7, dont la sémantique 'completed' -> 'pending' n'a plus de sens
-- une fois que claim_ ne transitionne plus jamais vers 'completed'
-- elle-même). service_role uniquement. Appelée EXCLUSIVEMENT par
-- Node, EXCLUSIVEMENT quand un claim_ a réussi (ligne 'processing')
-- MAIS que le Storage.remove() réel qui a suivi a lui-même échoué --
-- fait revenir EXACTEMENT cette ligne de 'processing' à 'pending'
-- (WHERE status='processing' AND claim_token=p_claim_token explicite),
-- pour un retry IMMÉDIAT sans attendre l'expiration du bail, SANS
-- jamais émettre un nouveau cleanup_id ni dupliquer l'état.
--
-- NON-BLOQUANT PAR CONCEPTION (mandat : "no reopen-or-die design") --
-- CETTE fonction est un raccourci de confort pour un retry immédiat,
-- JAMAIS l'UNIQUE mécanisme de récupération : que cet appel réussisse,
-- échoue (exception réseau/transport), ou renvoie `{ error }` côté
-- Supabase (Node vérifie EXPLICITEMENT les deux formes d'échec -- voir
-- lib/server/product-photo-service.ts), la ligne 'processing' devient
-- de toute façon réclamable DE NOUVEAU, automatiquement, dès
-- l'expiration du bail (lease_until) déjà posé par claim_ -- AUCUNE
-- dépendance exclusive à un appel explicite de libération pour rester
-- durablement retriable.
-- ------------------------------------------------------------

create function public.release_product_photo_pending_cleanup(
  p_caller_user_id uuid,
  p_product_id     uuid,
  p_cleanup_id     uuid,
  p_claim_token    uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant_id uuid;
  v_released      boolean;
begin
  v_restaurant_id := public.assert_product_role_for(p_caller_user_id, p_product_id, array['owner','manager']);

  if p_claim_token is null then
    return false;
  end if;

  update public.product_photo_pending_cleanups
  set status = 'pending', claimed_at = null, lease_until = null, claim_token = null
  where id = p_cleanup_id
    and restaurant_id = v_restaurant_id
    and product_id = p_product_id
    and status = 'processing'
    and claim_token = p_claim_token
  returning true into v_released;

  return coalesce(v_released, false);
end $$;

revoke all on function public.release_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_product_photo_pending_cleanup(uuid, uuid, uuid, uuid) to service_role;

-- ------------------------------------------------------------
-- 1k. Policies storage.objects -- RE-VÉRIFIÉES, AUCUN CHANGEMENT
-- (voir "POLICIES storage.objects" en tête de fichier). Toujours
-- `using (false)` / `with check (false)` pour authenticated depuis
-- v1.4, aucun octroi anon. Reproduites ici (drop+create, comme
-- v1.4/v1.5/v1.6) uniquement pour que ce fichier reste rejouable/
-- idempotent depuis le même baseline V67 -- aucun changement de
-- valeur.
-- ------------------------------------------------------------

drop policy "product_photos_select_own_restaurant" on storage.objects;
create policy "product_photos_select_own_restaurant"
on storage.objects for select
to authenticated
using (false);

drop policy "product_photos_insert_own_restaurant" on storage.objects;
create policy "product_photos_insert_own_restaurant"
on storage.objects for insert
to authenticated
with check (false);

drop policy "product_photos_update_own_restaurant" on storage.objects;
create policy "product_photos_update_own_restaurant"
on storage.objects for update
to authenticated
using (false)
with check (false);

drop policy "product_photos_delete_own_restaurant" on storage.objects;
create policy "product_photos_delete_own_restaurant"
on storage.objects for delete
to authenticated
using (false);

commit;
