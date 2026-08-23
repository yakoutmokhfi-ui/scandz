import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym LOT 2A — modes de vente génériques (fondations). GO CIO
// explicite avec 4 garde-fous : codes historiques conservés,
// provider/pricing_mode contraints, surcharge de champs limitée aux
// cas audités, restaurants-config.ts conservé comme filet transitoire.
// ====================================================================

const v82Sql = readFileSync("supabase/migration-v82-lot2a-sale-modes.sql", "utf8");
const v82RollbackSql = readFileSync("supabase/migration-v82-rollback.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v82-lot2a-check.sh", "utf8");
const orderPayloadSrc = readFileSync("lib/services/order-payload.ts", "utf8");

test("LOT 2A: découverte -- create_order redéfinie sur la VRAIE signature actuelle (7 arguments, p_language), pas l'ancienne à 6 arguments", () => {
  const orderLangSql = readFileSync("supabase/migration-orders-lang.sql", "utf8");
  assert.ok(orderLangSql.includes("p_language"));
  assert.ok(v82Sql.includes("p_language      text    default null"));
  assert.ok(v82Sql.includes("drop function if exists public.create_order(text, text, jsonb, integer, jsonb, text);"));
});

test("LOT 2A: découverte -- 2 contraintes CHECK historiques figées retirées, jamais laissées coexister avec la nouvelle validation générique", () => {
  assert.ok(v82Sql.includes("alter table public.orders drop constraint if exists orders_mode_fields;"));
  assert.ok(v82Sql.includes("alter table public.orders drop constraint if exists orders_service_mode_check;"));
});

test("LOT 2A: aucun GRANT INSERT direct sur orders pour anon/authenticated -- retirer les CHECK est sans danger, documenté explicitement", () => {
  assert.ok(v82Sql.includes("Confirmé sans danger : orders n'a AUCUN GRANT INSERT direct"));
});

test("LOT 2A: découverte -- le backfill illico-presto neutralise EXPLICITEMENT phone/email en 'optional', sinon le repli catalogue (one_of) exigerait quand même un contact", () => {
  const start = v82Sql.indexOf("Cas 1 : illico-presto");
  const end = v82Sql.indexOf("Cas 2 : sanaa-cookies");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("(r.id, 'pickup', 'phone', 'optional', 2)"));
  assert.ok(body.includes("(r.id, 'pickup', 'email', 'optional', 3)"));
});

test("Garde-fou CIO #1: les codes historiques table/pickup/delivery sont conservés tels quels, aucun renommage", () => {
  assert.ok(v82Sql.includes("('table',        'dine_in',  'Sur place / Table',  1)"));
  assert.ok(!v82Sql.includes("'on_site'"));
});

test("Garde-fou CIO #2: provider et pricing_mode sont contraints par CHECK, vocabulaire stable", () => {
  const start = v82Sql.indexOf("create table public.restaurant_sale_modes");
  const end = v82Sql.indexOf(");", start);
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("check (provider in ('internal', 'stuart', 'chronofresh', 'other_external'))"));
  assert.ok(body.includes("check (pricing_mode in ('free', 'fixed', 'free_above_threshold', 'external_quote'))"));
});

test("Garde-fou CIO #2 (suite): propriétés communes sont des colonnes TYPÉES, jamais dans config JSONB", () => {
  const start = v82Sql.indexOf("create table public.restaurant_sale_modes");
  const end = v82Sql.indexOf(");", start);
  const body = v82Sql.slice(start, end);
  for (const col of ["enabled", "display_order", "provider", "pricing_mode", "fixed_fee", "free_threshold", "delay_value", "delay_unit", "customer_text"]) {
    assert.ok(body.includes(`  ${col} `), `${col} doit être une colonne typée`);
  }
});

test("Garde-fou CIO #3: la surcharge par établissement n'existe QUE pour les 2 cas audités, pas une surcharge spéculative", () => {
  assert.ok(harnessSrc.includes('assert_eq "le-sirocco : aucune surcharge (comportement catalogue par défaut déjà correct)" "0"'));
});

test("Garde-fou CIO #4: restaurants-config.ts N'EST PAS supprimé dans ce lot", () => {
  const restaurantsConfigSrc = readFileSync("lib/restaurants-config.ts", "utf8");
  assert.ok(restaurantsConfigSrc.includes("DETTE TECHNIQUE ASSUMÉE"));
});

test("Garde-fou CIO #4 (suite): aucun fichier frontend n'est modifié par LOT 2A", () => {
  assert.ok(!orderPayloadSrc.includes("sale_mode_catalog"));
});

test("LOT 2A: backfill couvre les 4 cas EXACTS -- le-sirocco n'est pas exclu par erreur", () => {
  assert.ok(v82Sql.includes("Cas 1 : illico-presto"));
  assert.ok(v82Sql.includes("Cas 2 : sanaa-cookies"));
  assert.ok(v82Sql.includes("Cas 3 : le-sirocco"));
  assert.ok(v82Sql.includes("Cas 4 (défaut)"));
});

test("LOT 2A: sanaa-cookies n'hérite pas de 'table' par erreur -- le backfill retire ce que le cas 4 aurait ajouté à tort", () => {
  const start = v82Sql.indexOf("Cas 2 : sanaa-cookies");
  const end = v82Sql.indexOf("Cas 3 : le-sirocco");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("delete from public.restaurant_sale_modes where restaurant_id = r.id and mode_code = 'table';"));
});

test("LOT 2A: sale_mode_catalog n'est jamais supprimé physiquement", () => {
  assert.ok(v82Sql.includes("is_available_for_new_establishments"));
  assert.ok(!v82Sql.includes("delete from public.sale_mode_catalog"));
});

test("LOT 2A: orders.service_mode référence le catalogue par FK, jamais de fragilité historique possible", () => {
  assert.ok(v82Sql.includes("add constraint orders_service_mode_fkey foreign key (service_mode) references public.sale_mode_catalog(code);"));
});

test("LOT 2A: create_order valide les champs requis via une boucle générique, jamais un branchement par mode codé en dur", () => {
  const start = v82Sql.indexOf("create or replace function public.create_order");
  const end = v82Sql.lastIndexOf("end $$;");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("for v_req in"));
});

test("LOT 2A rollback: restaure create_order à son corps exact pré-LOT-2A", () => {
  assert.ok(v82RollbackSql.includes("p_language      text    default null"));
  assert.ok(!v82RollbackSql.includes("for v_req in"));
});

test("LOT 2A rollback: préflight refuse explicitement si commande incompatible existe", () => {
  assert.ok(v82RollbackSql.includes("SCANYM_ROLLBACK_BLOCKED"));
  assert.ok(v82RollbackSql.includes("service_mode not in ('table', 'pickup', 'delivery')"));
});

test("LOT 2A rollback: jamais auto-exécuté", () => {
  assert.ok(v82RollbackSql.includes("NE JAMAIS EXÉCUTER AUTOMATIQUEMENT"));
});

test("LOT 2A: le harnais PostgreSQL dédié couvre tous les scénarios exigés", () => {
  const requiredMarkers = [
    "illico-presto pickup: nom SEUL accepté",
    "sanaa-cookies pickup: nom SEUL refusé",
    "sanaa-cookies delivery: sans email refusé",
    "adresse structurée = adresse historique",
    "Click & Collect: ni téléphone ni email refusé",
    "room service sans numéro de chambre refusé",
    "mode delivery non activé pour illico-presto refusé",
    "table sans numéro toujours refusée (non-régression)",
    "rollback refusé -- commande click_collect existante incompatible",
    "rollback: réapplication propre réussie après annulation",
  ];
  for (const m of requiredMarkers) {
    assert.ok(harnessSrc.includes(m), `scénario manquant : ${m}`);
  }
});

// ====================================================================
// LOT 2A.1 — corrections après contre-audit Work (L2A-01 à L2A-06)
// ====================================================================

test("L2A-01: découverte -- DEUX redéfinitions de create_order manquées à l'audit initial (migration-v65-order-note.sql, migration-lotd-establishment-creation.sql), la seconde étant la SEULE réellement active au commit 7b4fdcf", () => {
  const lotdSql = readFileSync("supabase/migration-lotd-establishment-creation.sql", "utf8");
  assert.ok(lotdSql.includes("la version RÉELLEMENT active"));
  assert.ok(v82Sql.includes("status = 'active'"));
  assert.ok(v82Sql.includes("SCANYM_ORDER_NOTE_TOO_LONG"));
});

test("L2A-01: create_order vérifie is_active=true AND status='active' (protection Lot D restaurée), plus seulement is_active", () => {
  const start = v82Sql.indexOf("create or replace function public.create_order");
  const end = v82Sql.lastIndexOf("end $$;");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("is_active = true and status = 'active'"));
});

test("L2A-01: create_order rejette explicitement les notes > 500 caractères, jamais une troncature silencieuse (left(...,500) retiré)", () => {
  const start = v82Sql.indexOf("create or replace function public.create_order");
  const end = v82Sql.lastIndexOf("end $$;");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("SCANYM_ORDER_NOTE_TOO_LONG"));
  assert.ok(body.includes("btrim(coalesce(p_note, '')"), "doit utiliser le même jeu de caractères que le TypeScript, pas trim() natif");
  assert.ok(!body.includes("left(trim(coalesce(p_note,'')), 500)"), "l'ancienne troncature silencieuse ne doit plus exister");
});

test("L2A-02: room_number est une colonne dédiée sur orders (même patron que table_number), jamais une duplication d'un champ existant", () => {
  assert.ok(v82Sql.includes("add column if not exists room_number text check (room_number is null or length(room_number) <= 20)"));
});

test("L2A-02: create_order insère room_number dans orders (persistance réelle), pas seulement une validation", () => {
  const start = v82Sql.indexOf("create or replace function public.create_order");
  const end = v82Sql.lastIndexOf("end $$;");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("table_number, room_number,"));
  assert.ok(body.includes("case when p_service_mode = 'room_service' then v_room_number else null end"));
});

test("L2A-03: restaurant_sale_modes/restaurant_sale_mode_field_requirements n'ont plus jamais USING (true) -- corrigé une première fois en LOT 2A.1, puis le modèle a évolué en LOT 2A.2 (voir tests L2A1-01 ci-dessous pour le modèle définitif : tables strictement privées + projection publique dédiée)", () => {
  const start = v82Sql.indexOf("create table public.restaurant_sale_modes");
  const section = v82Sql.slice(start, v82Sql.indexOf("create table public.sale_mode_field_requirements"));
  assert.ok(!section.includes("using (true)"), "restaurant_sale_modes ne doit jamais avoir de policy USING (true)");
});

test("L2A-04: résolveur générique CENTRALISÉ -- un seul mapping champ->valeur, groupes one_of déterminés par agrégation SQL, aucun nom de groupe codé en dur", () => {
  const start = v82Sql.indexOf("create or replace function public.create_order");
  const end = v82Sql.lastIndexOf("end $$;");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("tmp_field_reqs"), "une seule structure temporaire centralisée");
  assert.ok(body.includes("bool_or(resolved_value is not null)"), "satisfaction de groupe déterminée génériquement par agrégation");
  assert.ok(!body.includes("one_of_group = 'contact'"), "aucun nom de groupe codé en dur");
});

test("L2A-05: GRANT SELECT explicite sur order_delivery_address pour authenticated (RLS seule ne suffit pas)", () => {
  assert.ok(v82Sql.includes("grant select on public.order_delivery_address to authenticated;"));
});

test("L2A-06: préflight rollback ne fait plus l'impasse sur les commandes personal_data_purged -- orders_service_mode_check n'a aucune clause d'échappement", () => {
  assert.ok(!v82RollbackSql.includes("and not personal_data_purged"), "l'ancienne exclusion erronée ne doit plus exister");
  assert.ok(v82RollbackSql.includes("where service_mode not in ('table', 'pickup', 'delivery');"));
});

test("LOT 2A.1: rollback restaure create_order au texte EXACT actif à 7b4fdcf (Lot D), pas une version intermédiaire obsolète", () => {
  assert.ok(v82RollbackSql.includes("status = 'active'"));
  assert.ok(v82RollbackSql.includes("SCANYM_ORDER_NOTE_TOO_LONG"));
  assert.ok(v82RollbackSql.includes("alter table public.orders drop column if exists room_number;"));
});

test("LOT 2A.1: le harnais PostgreSQL dédié couvre tous les nouveaux scénarios exigés par l'audit", () => {
  const requiredMarkers = [
    "établissement onboarding -> refusé",
    "établissement suspendu -> refusé",
    "établissement is_active=false -> refusé",
    "note de 501 caractères refusée avec SCANYM_ORDER_NOTE_TOO_LONG",
    "room_number '305' réellement récupérable",
    "membre A peut lire A même en onboarding",
    "utilisateur authentifié SANS appartenance -> ne peut lire aucun établissement",
    "groupe one_of 'reachability'",
    "GRANT SELECT explicite présent pour authenticated",
    "rollback refusé -- commande click_collect PURGÉE incompatible",
  ];
  for (const m of requiredMarkers) {
    assert.ok(harnessSrc.includes(m), `scénario manquant : ${m}`);
  }
});

// ====================================================================
// LOT 2A.2 — corrections après contre-audit Work (L2A1-01, L2A1-02)
// ====================================================================

test("L2A1-01: découverte -- 'to public' s'applique AUSSI aux sessions authentifiées, pas seulement anon -- violait le contrat 'membre A ne lit pas B' pour tout établissement actif", () => {
  const start = v82Sql.indexOf("create table public.restaurant_sale_modes");
  const section = v82Sql.slice(start, v82Sql.indexOf("create table public.sale_mode_field_requirements"));
  const codeOnly = section.replace(/--.*$/gm, "");
  assert.ok(!codeOnly.includes("to public"), "restaurant_sale_modes ne doit plus avoir de policy CODE 'to public' (une mention en commentaire expliquant l'ancien défaut est légitime)");
  assert.ok(!codeOnly.includes("r.is_active = true and r.status = 'active'"), "aucune exception 'établissement actif' pour la lecture directe de cette table tenant-privée");
});

test("L2A1-01: restaurant_sale_modes/restaurant_sale_mode_field_requirements sont désormais STRICTEMENT privées -- authenticated uniquement, appartenance réelle, aucun GRANT pour anon", () => {
  assert.ok(v82Sql.includes("grant select on public.restaurant_sale_modes to authenticated;"));
  assert.ok(!v82Sql.includes("grant select on public.restaurant_sale_modes to anon, authenticated;"));
  assert.ok(v82Sql.includes("revoke all on public.restaurant_sale_modes from anon;"));
  assert.ok(v82Sql.includes("grant select on public.restaurant_sale_mode_field_requirements to authenticated;"));
  assert.ok(v82Sql.includes("revoke all on public.restaurant_sale_mode_field_requirements from anon;"));
});

test("L2A1-01: projection publique minimale (get_restaurant_public_sale_modes) réutilise le patron déjà audité (get_restaurant_active_languages, LOT 1A) -- RPC SECURITY DEFINER, jamais un accès direct à la table", () => {
  assert.ok(v82Sql.includes("create function public.get_restaurant_public_sale_modes(p_restaurant_id uuid)"));
  const start = v82Sql.indexOf("create function public.get_restaurant_public_sale_modes");
  const end = v82Sql.indexOf("$$;", start);
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("security definer"));
  assert.ok(body.includes("r.is_active = true and r.status = 'active'"));
  assert.ok(body.includes("rsm.enabled = true"));
});

test("L2A1-01: la projection publique n'expose JAMAIS provider ni config JSONB brut (informations internes)", () => {
  const start = v82Sql.indexOf("returns table (\n  mode_code      text,");
  const end = v82Sql.indexOf(")", start);
  const returnShape = v82Sql.slice(start, end);
  assert.ok(!returnShape.includes("provider"));
  assert.ok(!returnShape.includes("config"));
});

test("L2A1-01: effective_sale_mode_field_requirements est une fonction interne PARTAGÉE (jamais dupliquée) -- réutilisée par create_order ET la projection publique", () => {
  assert.ok(v82Sql.includes("create function public.effective_sale_mode_field_requirements("));
  const occurrences = (v82Sql.match(/effective_sale_mode_field_requirements\(/g) || []).length;
  assert.ok(occurrences >= 3, "doit apparaître dans sa définition, dans create_order, et dans get_restaurant_public_field_requirements");
  // Corrigé en LOT 2A.3 (L2A2-01) : plus aucun GRANT, même pas vers
  // authenticated -- voir les tests L2A2-01 dédiés plus bas pour
  // l'assertion exacte sur ce point, devenu strictement interne.
  assert.ok(!v82Sql.includes("grant execute on function public.effective_sale_mode_field_requirements(uuid, text) to anon"), "jamais accessible directement par anon (contournement de la projection)");
});

test("L2A1-01: create_order n'a plus SA PROPRE copie de la fusion surcharge+catalogue -- délègue à la fonction partagée (renforce L2A-04)", () => {
  const start = v82Sql.indexOf("create or replace function public.create_order");
  const end = v82Sql.lastIndexOf("end $$;");
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("from public.effective_sale_mode_field_requirements(v_restaurant.id, p_service_mode) x;"));
  assert.ok(!body.includes("union all\n    select field, requirement, one_of_group from public.sale_mode_field_requirements"), "l'ancienne union inline ne doit plus exister dans create_order");
});

test("L2A1-02: contrainte d'intégrité one_of <-> one_of_group présente sur LES DEUX tables de règles (catalogue et surcharge)", () => {
  const catalogStart = v82Sql.indexOf("create table public.sale_mode_field_requirements");
  const catalogEnd = v82Sql.indexOf(");", v82Sql.indexOf("constraint sale_mode_field_requirements_one_of_group_check", catalogStart));
  const catalogBody = v82Sql.slice(catalogStart, catalogEnd);
  assert.ok(catalogBody.includes("requirement = 'one_of' and one_of_group is not null and btrim(one_of_group) <> ''"));
  assert.ok(catalogBody.includes("requirement in ('required', 'optional') and one_of_group is null"));

  const overrideStart = v82Sql.indexOf("create table public.restaurant_sale_mode_field_requirements");
  const overrideEnd = v82Sql.indexOf(");", v82Sql.indexOf("constraint restaurant_sale_mode_field_req_one_of_group_check", overrideStart));
  const overrideBody = v82Sql.slice(overrideStart, overrideEnd);
  assert.ok(overrideBody.includes("requirement = 'one_of' and one_of_group is not null and btrim(one_of_group) <> ''"));
});

test("LOT 2A.2 rollback: retire les 3 nouvelles fonctions (projection publique + résolveur partagé) avant les tables dont elles dépendent -- réapplication propre garantie", () => {
  assert.ok(v82RollbackSql.includes("drop function if exists public.get_restaurant_public_field_requirements(uuid, text);"));
  assert.ok(v82RollbackSql.includes("drop function if exists public.get_restaurant_public_sale_modes(uuid);"));
  assert.ok(v82RollbackSql.includes("drop function if exists public.effective_sale_mode_field_requirements(uuid, text);"));
});

test("LOT 2A.2: le harnais PostgreSQL dédié couvre tous les nouveaux scénarios exigés (contrat tenant strict, projection publique, contournement impossible, contrainte one_of)", () => {
  const requiredMarkers = [
    "anon NE PEUT PLUS lire restaurant_sale_modes directement",
    "membre A lisant B (actif) -> ZÉRO ligne",
    "membre B peut lire B (appartenance réelle)",
    "membre B lisant A -> ZÉRO ligne (symétrique)",
    "anon + établissement actif -> projection publique retourne des données",
    "anon + onboarding -> projection publique vide",
    "la projection publique n'expose ni provider ni config JSONB brut",
    "anon ne peut pas appeler directement effective_sale_mode_field_requirements",
    "one_of + groupe NULL refusé",
    "one_of + groupe uniquement espaces refusé",
    "required + groupe non-null refusé",
  ];
  for (const m of requiredMarkers) {
    assert.ok(harnessSrc.includes(m), `scénario manquant : ${m}`);
  }
});

// ====================================================================
// LOT 2A.3 — corrections après contre-audit Work (L2A2-01, L2A2-02)
// ====================================================================

test("L2A2-01: découverte -- effective_sale_mode_field_requirements était exécutable par authenticated, permettant un contournement direct de la RLS des tables tenant, indépendamment de toute appartenance", () => {
  assert.ok(v82Sql.includes("revoke all on function public.effective_sale_mode_field_requirements(uuid, text) from public, anon, authenticated;"));
  assert.ok(!v82Sql.includes("grant execute on function public.effective_sale_mode_field_requirements(uuid, text) to authenticated;"), "l'ancien GRANT vers authenticated ne doit plus exister");
});

test("L2A2-01: le helper est désormais TOTALEMENT interne -- aucun rôle (public, anon, authenticated) n'a le droit d'EXECUTE", () => {
  const revokeIdx = v82Sql.indexOf("revoke all on function public.effective_sale_mode_field_requirements(uuid, text) from public, anon, authenticated;");
  assert.ok(revokeIdx > 0);
  const afterRevoke = v82Sql.slice(revokeIdx, revokeIdx + 300);
  assert.ok(!afterRevoke.includes("grant execute on function public.effective_sale_mode_field_requirements"), "aucun GRANT ne doit suivre ce revoke pour cette fonction");
});

test("L2A2-01: aucun auth.uid() ajouté artificiellement à l'intérieur du helper -- l'architecture délègue l'autorisation aux appelants contrôlés, jamais dupliquée ici", () => {
  const start = v82Sql.indexOf("create function public.effective_sale_mode_field_requirements");
  const end = v82Sql.indexOf("$$;", start);
  const body = v82Sql.slice(start, end);
  assert.ok(!body.includes("auth.uid()"), "le helper reste un simple SELECT de fusion, sans logique d'autorisation propre");
  assert.ok(body.includes("language sql"), "reste une fonction SQL simple, pas transformée en plpgsql pour ajouter une vérification");
});

test("L2A2-02: découverte -- la projection publique ne vérifiait pas que le mode demandé était réellement activé pour l'établissement, exposant les règles catalogue pour un mode désactivé/jamais configuré", () => {
  const start = v82Sql.indexOf("create function public.get_restaurant_public_field_requirements");
  const end = v82Sql.indexOf("$$;", start);
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("rsm.enabled = true"), "doit vérifier explicitement que le mode est activé");
  assert.ok(body.includes("rsm.mode_code = p_mode_code"), "doit vérifier que le mode demandé correspond à une ligne réelle de restaurant_sale_modes");
});

test("L2A2-02: la vérification enabled=true s'ajoute à la vérification d'établissement actif déjà présente, jamais un remplacement", () => {
  const start = v82Sql.indexOf("create function public.get_restaurant_public_field_requirements");
  const end = v82Sql.indexOf("$$;", start);
  const body = v82Sql.slice(start, end);
  assert.ok(body.includes("r.is_active = true and r.status = 'active'"), "la vérification d'établissement actif doit rester présente");
  assert.ok(body.includes("from public.restaurant_sale_modes rsm"), "nouvelle vérification ajoutée, pas substituée");
});

test("LOT 2A.3: le harnais PostgreSQL dédié couvre tous les nouveaux scénarios exigés (5 tentatives de contournement du helper, 6 cas de la projection publique par mode)", () => {
  const requiredMarkers = [
    "membre A appelant le helper pour SON PROPRE établissement A -> refusé quand même",
    "membre A appelant le helper pour B -> refusé",
    "membre B appelant le helper pour A -> refusé",
    "utilisateur authentifié non affilié appelant le helper -> refusé",
    "create_order fonctionne toujours (appel interne SECURITY DEFINER autorisé malgré le retrait du GRANT)",
    "la projection publique fonctionne toujours (appel interne autorisé)",
    "actif + mode DÉSACTIVÉ -> aucun résultat",
    "actif + mode ABSENT de restaurant_sale_modes (jamais configuré) -> aucun résultat",
    "onboarding + mode activé -> aucun résultat",
    "suspendu + mode activé -> aucun résultat",
    "inactif + mode activé -> aucun résultat",
  ];
  for (const m of requiredMarkers) {
    assert.ok(harnessSrc.includes(m), `scénario manquant : ${m}`);
  }
});
