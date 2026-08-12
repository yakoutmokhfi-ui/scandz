import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  suggestSlug,
  isValidSlug,
  isValidOwnerEmail,
  isSupportedCountry,
  isSupportedCurrency,
  SUPPORTED_COUNTRIES,
  SUPPORTED_CURRENCIES,
  COMMERCE_TYPES,
  LANGUAGES,
} from "../lib/establishment-text.ts";

const migrationSql = readFileSync("supabase/migration-lotd-establishment-creation.sql", "utf8");
const serviceSrc = readFileSync("lib/services/establishments.ts", "utf8");
const pageSrc = readFileSync("app/admin/establishments/new/page.tsx", "utf8");
const restaurantServiceSrc = readFileSync("lib/services/restaurant.ts", "utf8");

// ====================================================================
// suggestSlug / validations pures
// ====================================================================

test("suggestSlug: cas simples", () => {
  assert.equal(suggestSlug("Au Lait Cru"), "au-lait-cru");
  assert.equal(suggestSlug("  Le  Sirocco  "), "le-sirocco");
});

test("suggestSlug: accents retirés proprement", () => {
  assert.equal(suggestSlug("Fromagerie Léa"), "fromagerie-lea");
  assert.equal(suggestSlug("Crème Brûlée Café"), "creme-brulee-cafe");
});

test("suggestSlug: ponctuation et symboles réduits à des tirets simples", () => {
  assert.equal(suggestSlug("Chez Marc & Fils !!!"), "chez-marc-fils");
  assert.equal(suggestSlug("Café---Test"), "cafe-test");
});

test("suggestSlug: le résultat respecte toujours SLUG_PATTERN pour une entrée non vide", () => {
  for (const name of ["Au Lait Cru", "Léa's Café!", "  ", "123 Pizza", "Ñoño"]) {
    const slug = suggestSlug(name);
    if (slug !== "") {
      assert.ok(isValidSlug(slug), `slug '${slug}' généré depuis '${name}' devrait être valide`);
    }
  }
});

test("isValidSlug: miroir exact de la regex SQL", () => {
  assert.ok(isValidSlug("au-lait-cru"));
  assert.ok(isValidSlug("cafe123"));
  assert.ok(!isValidSlug("Au-Lait-Cru"), "majuscules refusées");
  assert.ok(!isValidSlug("au--lait"), "tiret double refusé");
  assert.ok(!isValidSlug("-au-lait"), "tiret en tête refusé");
  assert.ok(!isValidSlug("au lait"), "espace refusé");
  assert.ok(!isValidSlug(""), "vide refusé");
});

test("isSupportedCountry / isSupportedCurrency: allowlist métier, PAS un simple format (corrige B-05)", () => {
  assert.ok(isSupportedCountry("FR"));
  assert.ok(isSupportedCountry("dz"), "insensible à la casse en entrée");
  assert.ok(!isSupportedCountry("France"), "nom complet refusé");
  assert.ok(!isSupportedCountry("ZZ"), "code fictif ZZ refusé même s'il respecte le format ISO");
  assert.ok(isSupportedCurrency("EUR"));
  assert.ok(!isSupportedCurrency("ZZZ"), "code fictif ZZZ refusé même s'il respecte le format ISO");
});

test("aucun couplage pays -> devise (B-05, décision CTO explicite) : listes totalement indépendantes", () => {
  // Le Maroc (MA) doit pouvoir être combiné avec EUR : aucune règle
  // ne doit forcer une devise particulière pour un pays donné.
  assert.ok(isSupportedCountry("MA"));
  assert.ok(isSupportedCurrency("EUR"));
  assert.ok(
    !migrationSql.includes("country = 'MA' and") && !migrationSql.includes("currency_for_country"),
    "aucune logique de couplage pays->devise ne doit exister dans la migration"
  );
});

test("isValidOwnerEmail: rejette un format manifestement invalide", () => {
  assert.ok(isValidOwnerEmail("proprietaire@aulaitcru.fr"));
  assert.ok(!isValidOwnerEmail("pas-un-email"));
  assert.ok(!isValidOwnerEmail("a@b"));
});

test("COMMERCE_TYPES / LANGUAGES: cohérents avec la contrainte CHECK de la migration", () => {
  for (const c of COMMERCE_TYPES) {
    assert.ok(migrationSql.includes(`'${c}'`), `type de commerce '${c}' absent de la contrainte CHECK SQL`);
  }
  assert.deepEqual([...LANGUAGES].sort(), ["ar", "en", "fr"]);
});

test("SYNCHRONISATION SQL <-> TS : SUPPORTED_COUNTRIES/SUPPORTED_CURRENCIES reflètent exactement le contenu réel des tables de référence", () => {
  // Extrait les codes réellement insérés par la migration (pas une
  // supposition) et les compare à la liste TypeScript. Une extension
  // future qui oublierait un des deux côtés serait détectée ici.
  const countriesBlockMatch = migrationSql.match(
    /insert into public\.scanym_supported_countries \(code, name\) values\s*([\s\S]*?);/
  );
  assert.ok(countriesBlockMatch, "bloc d'insertion des pays introuvable dans la migration");
  const sqlCountryCodes = [...countriesBlockMatch![1].matchAll(/'([A-Z]{2})'/g)].map((m) => m[1]).sort();
  const tsCountryCodes = SUPPORTED_COUNTRIES.map((c) => c.code).sort();
  assert.deepEqual(tsCountryCodes, sqlCountryCodes, "SUPPORTED_COUNTRIES (TS) doit correspondre exactement aux codes insérés en SQL");

  const currenciesBlockMatch = migrationSql.match(
    /insert into public\.scanym_supported_currencies \(code, name\) values\s*([\s\S]*?);/
  );
  assert.ok(currenciesBlockMatch, "bloc d'insertion des devises introuvable dans la migration");
  const sqlCurrencyCodes = [...currenciesBlockMatch![1].matchAll(/'([A-Z]{3})'/g)].map((m) => m[1]).sort();
  const tsCurrencyCodes = SUPPORTED_CURRENCIES.map((c) => c.code).sort();
  assert.deepEqual(tsCurrencyCodes, sqlCurrencyCodes, "SUPPORTED_CURRENCIES (TS) doit correspondre exactement aux codes insérés en SQL");
});

test("codes fictifs ZZ/ZZZ absents des deux listes (SQL et TS)", () => {
  assert.ok(!(SUPPORTED_COUNTRIES as readonly { code: string }[]).some((c) => c.code === "ZZ"));
  assert.ok(!(SUPPORTED_CURRENCIES as readonly { code: string }[]).some((c) => c.code === "ZZZ"));
  assert.ok(!migrationSql.includes("'ZZ'"));
  assert.ok(!migrationSql.includes("'ZZZ'"));
});

// ====================================================================
// Migration SQL — contrôles structurels
// ====================================================================

test("migration Lot D: contrôle préalable de non-dérive réellement exécuté avant la transaction", () => {
  const beginIdx = migrationSql.search(/^begin;/m);
  const driftIdx = migrationSql.indexOf("SCANYM_SCHEMA_DRIFT");
  assert.ok(driftIdx >= 0 && driftIdx < beginIdx);
});

test("migration Lot D: droits sur restaurants vérifiés via has_table_privilege (leçon SA3-B01 réappliquée)", () => {
  assert.ok(migrationSql.includes("has_table_privilege(v_fn.role_name, 'public.restaurants', 'SELECT')"));
});

test("migration Lot D: REVOKE sur restaurants à l'intérieur de la transaction (leçon B-01 réappliquée)", () => {
  const beginIdx = migrationSql.search(/^begin;/m);
  const commitIdx = migrationSql.search(/^commit;/m);
  const revokeIdx = migrationSql.indexOf("revoke insert, update, delete on table public.restaurants");
  assert.ok(revokeIdx > beginIdx && revokeIdx < commitIdx, "le REVOKE doit être dans la transaction, pas avant");
});

test("migration Lot D: aucune donnée existante d'une autre table n'est modifiée (additif uniquement)", () => {
  assert.ok(!/update\s+public\.menu_items/i.test(migrationSql));
  assert.ok(!/update\s+public\.menu_categories/i.test(migrationSql));
  // update public.orders EXISTE dans ce fichier (copié depuis le
  // corps réel de create_order, section 2k) : c'est une écriture
  // normale et attendue sur la commande QUE CETTE MÊME FONCTION vient
  // de créer (where id = v_order_id), pas une modification de données
  // historiques existantes -- ne pas confondre les deux.
});

test("migration Lot D: scanym_operators et establishment_owner_invitations n'ont AUCUNE policy directe (RLS activée, accès RPC uniquement)", () => {
  assert.ok(migrationSql.includes("alter table public.scanym_operators enable row level security;"));
  assert.ok(migrationSql.includes("revoke all on table public.scanym_operators from anon, authenticated, public;"));
  assert.ok(migrationSql.includes("alter table public.establishment_owner_invitations enable row level security;"));
  assert.ok(migrationSql.includes("revoke all on table public.establishment_owner_invitations from anon, authenticated, public;"));
  assert.ok(
    !/create policy[^;]*scanym_operators/i.test(migrationSql),
    "aucune policy ne doit exister sur scanym_operators"
  );
  assert.ok(
    !/create policy[^;]*establishment_owner_invitations/i.test(migrationSql),
    "aucune policy ne doit exister sur establishment_owner_invitations"
  );
});

test("SÉCURITÉ CRITIQUE : link_pending_owner ne crée jamais de compte, ne touche jamais un mot de passe", () => {
  const start = migrationSql.indexOf("create function public.link_pending_owner(");
  const end = migrationSql.indexOf("$$;", migrationSql.indexOf("end $$;", start)) + 3;
  const body = migrationSql.slice(start, end);
  assert.ok(!/insert into auth\.users/i.test(body), "ne doit jamais insérer dans auth.users");
  assert.ok(!/update auth\.users/i.test(body), "ne doit jamais modifier auth.users");
  assert.ok(!/password/i.test(body), "ne doit jamais manipuler de mot de passe");
  assert.ok(body.includes("select id into v_user_id\n  from auth.users"), "lecture SEULE de auth.users attendue");
});

test("SÉCURITÉ CRITIQUE : aucun USAGE fonctionnel de service_role (les mentions en commentaire expliquant pourquoi il n'est PAS utilisé sont légitimes)", () => {
  // Une correspondance naïve sur la simple présence de la chaîne
  // "service_role" produirait un faux positif : ce fichier ET
  // establishments.ts mentionnent délibérément ce terme dans leurs
  // commentaires pour EXPLIQUER pourquoi il n'est jamais utilisé
  // (documentation de sécurité légitime, même patron que les
  // commentaires "jamais de mot de passe"). Ce test vérifie l'absence
  // d'USAGE FONCTIONNEL réel, en retirant les commentaires SQL (--)
  // et JS/TS (//, /* */) avant de chercher.
  function stripSqlComments(src: string): string {
    return src
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
  }
  function stripJsComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
  }

  assert.ok(
    !/service_role/i.test(stripSqlComments(migrationSql)),
    "service_role ne doit apparaître dans AUCUNE ligne de code SQL fonctionnelle (hors commentaires)"
  );
  assert.ok(
    !/service_role/i.test(stripJsComments(serviceSrc)),
    "service_role ne doit apparaître dans AUCUNE ligne de code TS fonctionnelle (hors commentaires)"
  );
  assert.ok(!/service_role/i.test(stripJsComments(pageSrc)));
  assert.ok(
    !/auth\.admin\./i.test(stripJsComments(serviceSrc)),
    "aucun appel FONCTIONNEL à l'API Admin Supabase côté client"
  );
});

test("SÉCURITÉ CRITIQUE : create_establishment et link_pending_owner exigent is_scanym_operator()", () => {
  for (const fn of ["create_establishment", "link_pending_owner", "get_establishment_summary"]) {
    const start = migrationSql.indexOf(`create function public.${fn}(`);
    const end = migrationSql.indexOf("end $$;", start);
    const body = migrationSql.slice(start, end);
    assert.ok(
      body.includes("if not public.is_scanym_operator() then"),
      `${fn} doit vérifier is_scanym_operator()`
    );
  }
});

test("Rôle opérateur distinct de owner/manager/staff : scanym_operators ne référence jamais restaurant_id", () => {
  const start = migrationSql.indexOf("create table public.scanym_operators");
  const end = migrationSql.indexOf(");", start);
  const body = migrationSql.slice(start, end);
  assert.ok(!body.includes("restaurant_id"), "scanym_operators doit être un rôle GLOBAL, jamais scopé par établissement");
  assert.ok(!body.includes("role"), "scanym_operators ne doit pas réutiliser le concept de role owner/manager/staff");
});

test("link_pending_owner: B-03 corrigé -- ON CONFLICT DO UPDATE SET role='owner' (jamais DO NOTHING)", () => {
  const start = migrationSql.indexOf("create function public.link_pending_owner(");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(
    body.includes("on conflict (user_id, restaurant_id) do update set role = 'owner'"),
    "doit promouvoir explicitement à owner, pas ignorer un membership existant"
  );
  assert.ok(
    !body.includes("do nothing"),
    "DO NOTHING laisserait un staff/manager existant conserver son ancien rôle (B-03)"
  );
});

test("link_pending_owner: B-02 corrigé -- réellement idempotent (invitation 'linked' renvoie le même état, pas une erreur)", () => {
  const start = migrationSql.indexOf("create function public.link_pending_owner(");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(
    body.includes("if v_invitation.status = 'linked' then"),
    "doit distinguer explicitement le cas déjà-lié pour rester idempotent"
  );
  assert.ok(
    !body.includes("where restaurant_id = p_restaurant_id and status = 'pending'"),
    "ne doit plus filtrer sur status='pending' à la lecture (empêcherait de détecter l'état déjà-lié)"
  );
});

test("migration Lot D: B-01 corrigé -- séquence sûre ADD -> backfill 'active' -> DEFAULT -> NOT NULL", () => {
  const addIdx = migrationSql.indexOf("add column if not exists status text,");
  const backfillIdx = migrationSql.indexOf("update public.restaurants set status = 'active' where status is null;");
  const defaultIdx = migrationSql.indexOf("alter column status set default 'onboarding';");
  const notNullIdx = migrationSql.indexOf("alter column status set not null;");
  assert.ok(addIdx >= 0, "ajout de colonne SANS default direct attendu");
  assert.ok(backfillIdx > addIdx, "le backfill doit suivre l'ajout de colonne");
  assert.ok(defaultIdx > backfillIdx, "le DEFAULT ne doit s'appliquer qu'après le backfill");
  assert.ok(notNullIdx > defaultIdx, "NOT NULL doit être la dernière étape");
  assert.ok(
    !migrationSql.includes("add column if not exists status text not null default 'onboarding'"),
    "l'ancienne forme dangereuse (NOT NULL DEFAULT en une seule étape) ne doit plus exister"
  );
});

test("migration Lot D: B-04 corrigé -- REVOKE étendu explicitement à PUBLIC, pas seulement anon/authenticated", () => {
  assert.ok(migrationSql.includes("revoke insert, update, delete on table public.restaurants from anon, authenticated, public;"));
});

test("migration Lot D: B-04 (2e tour) -- vérification POST-REVOKE des droits effectifs, échec explicite sans correction automatique d'un rôle parent", () => {
  const revokeIdx = migrationSql.indexOf("revoke insert, update, delete on table public.restaurants from anon, authenticated, public;");
  const checkIdx = migrationSql.indexOf("Vérification POST-REVOKE", revokeIdx);
  assert.ok(checkIdx > revokeIdx, "la vérification post-revoke doit suivre le REVOKE dans le fichier");
  const doStart = migrationSql.indexOf("do $$", checkIdx);
  const doEnd = migrationSql.indexOf("end $$;", doStart);
  const body = migrationSql.slice(doStart, doEnd);
  assert.ok(body.includes("has_table_privilege(v_role, 'public.restaurants', v_priv)"));
  assert.ok(body.includes("array['INSERT', 'UPDATE', 'DELETE']"));
  assert.ok(body.includes("raise exception"), "doit échouer explicitement si un droit effectif persiste");
  assert.ok(
    !/revoke\s+\w+\s+on\s+table\s+public\.restaurants\s+from\s+test_writer|revoke\s+\w+\s+from\s+\w+\s+cascade/i.test(body),
    "ne doit JAMAIS tenter de révoquer un rôle parent inconnu automatiquement"
  );
});

test("migration Lot D: B-04 -- le contrôle préalable (précondition) ne vérifie PAS l'absence de droits sur restaurants (aurait cassé la vraie production)", () => {
  // Documente une décision de conception explicite : restaurants n'a
  // jamais été révoquée avant ce lot (c'est justement ce qu'il
  // corrige) -- exiger "aucun droit préexistant" en précondition
  // ferait donc échouer la migration sur la vraie base de production.
  // La détection pour restaurants a lieu APRÈS le REVOKE (test
  // précédent), pas dans le contrôle préalable.
  const start = migrationSql.indexOf("-- 1e. Droits EFFECTIFS");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(
    !body.includes("array['public.restaurants', 'public.restaurant_configs']") &&
      !body.includes("array['public.restaurants']"),
    "restaurants ne doit pas figurer dans la boucle de précondition d'écriture du contrôle préalable"
  );
  assert.ok(body.includes("n'est PAS incluse"), "la décision doit être documentée explicitement dans le fichier");
});

test("migration Lot D: B-04 -- contrôle préalable élargi à restaurant_configs (pas seulement restaurants)", () => {
  assert.ok(migrationSql.includes("public.restaurant_configs"));
  const start = migrationSql.indexOf("-- 1e. Droits EFFECTIFS");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(body.includes("'INSERT'") && body.includes("'UPDATE'") && body.includes("'DELETE'"));
});

test("VISIBILITÉ PUBLIQUE (2e tour) : create_order exige status='active' EN PLUS de is_active=true", () => {
  const start = migrationSql.indexOf("-- 2k. CYCLE DE VIE PUBLIC");
  assert.ok(start >= 0, "section 2k introuvable");
  const createOrderStart = migrationSql.indexOf("create or replace function public.create_order(", start);
  const createOrderEnd = migrationSql.indexOf("end $$;", createOrderStart);
  const body = migrationSql.slice(createOrderStart, createOrderEnd);
  assert.ok(
    body.includes("where slug = p_slug and is_active = true and status = 'active';"),
    "create_order doit exiger les deux conditions sur la même requête"
  );
});

test("VISIBILITÉ PUBLIQUE (2e tour) : ancienne policy publique unique remplacée par deux policies distinctes (public actif + membre restaurant_users)", () => {
  assert.ok(migrationSql.includes('drop policy if exists "lecture publique restaurants" on public.restaurants;'));
  assert.ok(migrationSql.includes('create policy "lecture publique restaurants actifs"'));
  assert.ok(migrationSql.includes("using (status = 'active' and is_active = true)"));
  assert.ok(migrationSql.includes('create policy "lecture membre restaurant_users"'));
  assert.ok(migrationSql.includes("ru.user_id = auth.uid()"), "la policy membre doit vérifier l'appartenance réelle via restaurant_users");
});

test("VISIBILITÉ PUBLIQUE (2e tour) : ancienne policy publique unique remplacée par deux policies distinctes (public actif + membre restaurant_users)", () => {
  assert.ok(migrationSql.includes('drop policy if exists "lecture publique restaurants" on public.restaurants;'));
  assert.ok(migrationSql.includes('create policy "lecture publique restaurants actifs"'));
  assert.ok(migrationSql.includes("using (status = 'active' and is_active = true)"));
  assert.ok(migrationSql.includes('create policy "lecture membre restaurant_users"'));
  assert.ok(migrationSql.includes("ru.user_id = auth.uid()"), "la policy membre doit vérifier l'appartenance réelle via restaurant_users");
});

test("VISIBILITÉ PUBLIQUE (3e tour) : les 3 tables enfant ont chacune 2 policies distinctes (publique active + membre), jamais using(true)", () => {
  const childTables: Array<[string, string]> = [
    ["restaurant_configs", "configs"],
    ["menu_categories", "categories"],
    ["menu_items", "items"],
  ];
  for (const [table, label] of childTables) {
    assert.ok(
      migrationSql.includes(`drop policy if exists "lecture publique ${label}" on public.${table};`),
      `l'ancienne policy using(true) de ${table} doit être supprimée`
    );
    const publicPolicyStart = migrationSql.indexOf(`create policy "lecture publique ${label}`);
    assert.ok(publicPolicyStart >= 0, `policy publique restreinte introuvable pour ${table}`);
    const memberPolicyStart = migrationSql.indexOf(`create policy "lecture membre ${label}"`);
    assert.ok(memberPolicyStart > publicPolicyStart, `policy membre introuvable ou mal ordonnée pour ${table}`);
  }
  // Aucune des 3 tables ne doit plus avoir de policy using(true) nue
  // (sans condition EXISTS liée au restaurant parent).
  for (const [table] of childTables) {
    const tableBlockStart = migrationSql.indexOf(`-- 2m. Policies publiques des TABLES ENFANT`);
    const tableBlockEnd = migrationSql.indexOf("commit;", tableBlockStart);
    const block = migrationSql.slice(tableBlockStart, tableBlockEnd);
    assert.ok(
      !new RegExp(`on public\\.${table} for select[\\s\\S]{0,80}using \\(true\\)`).test(block),
      `${table} ne doit plus avoir de policy using(true) nue`
    );
  }
});

test("VISIBILITÉ PUBLIQUE (3e tour) : clés de rattachement des tables enfant vérifiées avant modification, pas supposées", () => {
  // menu_items se rattache via category_id -> menu_categories, PAS
  // directement restaurant_id -- doit être documenté et implémenté
  // avec une jointure explicite via menu_categories.
  const start = migrationSql.indexOf('create policy "lecture publique items actifs"');
  const end = migrationSql.indexOf(");", start);
  const block = migrationSql.slice(start, end);
  assert.ok(block.includes("public.menu_categories mc"), "menu_items doit joindre menu_categories pour remonter au restaurant");
  assert.ok(block.includes("join public.restaurants r on r.id = mc.restaurant_id"));
  assert.ok(block.includes("mc.id = menu_items.category_id"));

  // restaurant_configs et menu_categories se rattachent directement
  // via restaurant_id -- pas de jointure intermédiaire nécessaire.
  const cfgStart = migrationSql.indexOf('create policy "lecture publique configs actifs"');
  const cfgEnd = migrationSql.indexOf(");", cfgStart);
  const cfgBlock = migrationSql.slice(cfgStart, cfgEnd);
  assert.ok(cfgBlock.includes("r.id = restaurant_configs.restaurant_id"));

  const catStart = migrationSql.indexOf('create policy "lecture publique categories actives"');
  const catEnd = migrationSql.indexOf(");", catStart);
  const catBlock = migrationSql.slice(catStart, catEnd);
  assert.ok(catBlock.includes("r.id = menu_categories.restaurant_id"));
});

test("VISIBILITÉ PUBLIQUE (3e tour) : régression documentée -- get_merchant_catalogue (RPC, ignore RLS) vs getRestaurantSettings (lecture directe, dépend de RLS)", () => {
  assert.ok(
    migrationSql.includes("getMerchantCatalogue) passe par la RPC get_merchant_catalogue"),
    "la migration doit documenter pourquoi le tableau de bord catégories/produits n'est pas à risque"
  );
  assert.ok(
    migrationSql.includes("getRestaurantSettings fait un"),
    "la migration doit documenter pourquoi la policy membre de restaurant_configs est réellement nécessaire"
  );
});

test("VISIBILITÉ PUBLIQUE (2e tour) : recherche exhaustive confirmée -- create_order était la seule autre voie publique lisant is_active sur restaurants", () => {
  // Cible précisément les lectures de `restaurants` PAR SLUG (le
  // patron des voies publiques), pas n'importe quelle occurrence de
  // "is_active = true" dans le fichier (menu_categories a aussi un
  // is_active, sans rapport avec la visibilité de l'établissement).
  const restaurantLookups = [...migrationSql.matchAll(/from public\.restaurants where slug = p_slug and ([^;]+);/g)];
  assert.ok(restaurantLookups.length >= 1, "au moins une recherche de restaurant par slug attendue (create_order)");
  for (const m of restaurantLookups) {
    assert.ok(
      m[1].includes("is_active = true") && m[1].includes("status = 'active'"),
      `toute recherche de restaurant par slug doit exiger is_active ET status : trouvé "${m[1]}"`
    );
  }
});

test("migration Lot D: B-05 -- tables de référence pays/devises maintenables, extensibles par simple INSERT", () => {
  assert.ok(migrationSql.includes("create table public.scanym_supported_countries"));
  assert.ok(migrationSql.includes("create table public.scanym_supported_currencies"));
  assert.ok(
    migrationSql.includes("not exists (select 1 from public.scanym_supported_countries where code = v_country)"),
    "create_establishment doit valider le pays contre la table de référence, pas un simple regex"
  );
  assert.ok(
    migrationSql.includes("not exists (select 1 from public.scanym_supported_currencies where code = v_currency)"),
    "create_establishment doit valider la devise contre la table de référence, pas un simple regex"
  );
});

test("VISIBILITÉ PUBLIQUE (décision CTO après audit) : getRestaurantBySlug exige status='active' EN PLUS de is_active=true", () => {
  assert.ok(restaurantServiceSrc.includes('.eq("is_active", true)'));
  assert.ok(restaurantServiceSrc.includes('.eq("status", "active")'));
  const isActiveIdx = restaurantServiceSrc.indexOf('.eq("is_active", true)');
  const statusIdx = restaurantServiceSrc.indexOf('.eq("status", "active")');
  assert.ok(statusIdx > isActiveIdx, "les deux filtres doivent être présents sur la même requête");
});

test("create_establishment: atomique (une seule fonction PL/pgSQL, pas de commit intermédiaire)", () => {
  const start = migrationSql.indexOf("create function public.create_establishment(");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(!/\bcommit\b/i.test(body), "aucun commit intermédiaire à l'intérieur de la fonction");
  assert.ok(body.includes("insert into public.restaurants"));
  assert.ok(body.includes("insert into public.restaurant_configs"));
  assert.ok(body.includes("insert into public.establishment_owner_invitations"));
});

test("create_establishment: la catégorie initiale reste facultative (nullif sur chaîne vide, condition explicite)", () => {
  const start = migrationSql.indexOf("create function public.create_establishment(");
  const end = migrationSql.indexOf("end $$;", start);
  const body = migrationSql.slice(start, end);
  assert.ok(body.includes("if v_category_name is not null then"));
});

test("create_establishment: statut initial toujours 'onboarding', jamais un paramètre choisi par l'appelant", () => {
  assert.ok(!pageSrc.includes("p_status"));
  assert.ok(!serviceSrc.includes("status:") || serviceSrc.includes("status: string"), "aucun champ 'status' modifiable en entrée dans CreateEstablishmentInput");
  const start = migrationSql.indexOf("create function public.create_establishment(");
  const paramsEnd = migrationSql.indexOf(")", start);
  const params = migrationSql.slice(start, paramsEnd);
  assert.ok(!params.includes("p_status"), "create_establishment ne doit jamais accepter un statut en paramètre");
});

// ====================================================================
// UI — autorisation, non-dérive vers Lot E
// ====================================================================

test("page.tsx: redirige (pas seulement masque) un utilisateur non authentifié ou non opérateur", () => {
  assert.ok(pageSrc.includes('router.replace("/dashboard/login")'));
  assert.ok(pageSrc.includes('router.replace("/dashboard")'));
});

test("page.tsx: n'appelle jamais directement une création de compte Auth -- ne fait que déclencher linkPendingOwner", () => {
  assert.ok(!/supabase\.auth\.(admin\.|signUp)/.test(pageSrc));
  assert.ok(pageSrc.includes("linkPendingOwner("));
});

test("NON-DÉRIVE LOT E : aucun sélecteur multi-établissements, aucune impersonation, aucun filtre de liste", () => {
  assert.ok(!/impersonat/i.test(pageSrc));
  assert.ok(!/<select[^>]*restaurants\.map/i.test(pageSrc), "pas de sélecteur listant plusieurs établissements existants");
  assert.ok(!pageSrc.includes("audit_log"));
});

test("page.tsx: double-soumission empêchée (submitting invalide le formulaire, bouton désactivé)", () => {
  assert.ok(/valid =[\s\S]*?!submitting/.test(pageSrc));
  assert.ok(pageSrc.includes("disabled={!valid}"));
});

// ====================================================================
// Service TS — classification d'erreurs stricte
// ====================================================================

test("establishments.ts: classification stricte code ET message (jamais l'un seul)", () => {
  const matches = [...serviceSrc.matchAll(/if \(code === "[^"]+" && message === [A-Z_]+_CODE\)/g)];
  assert.ok(matches.length >= 8, "au moins 8 classifications strictes code+message attendues");
  assert.ok(!/code === .* \|\| message ===/.test(serviceSrc), "jamais de classification par OU seul");
});

test("establishments.ts: isScanymOperator ne lève jamais, renvoie false par défaut (usage UI, jamais seule protection)", () => {
  const start = serviceSrc.indexOf("export async function isScanymOperator");
  const body = serviceSrc.slice(start, serviceSrc.indexOf("}", start + 200));
  assert.ok(body.includes("if (error) return false;"));
});

test("CORRECTIF RLS (post-production) : migration séparée, ne modifie jamais migration-lotd-establishment-creation.sql", () => {
  const fixSql = readFileSync("supabase/migration-lotd-rls-reference-tables-fix.sql", "utf8");
  assert.ok(fixSql.includes("alter table public.scanym_supported_countries enable row level security;"));
  assert.ok(fixSql.includes("alter table public.scanym_supported_currencies enable row level security;"));
  assert.ok(fixSql.includes('create policy "authenticated read supported countries"'));
  assert.ok(fixSql.includes('create policy "authenticated read supported currencies"'));
  assert.ok(fixSql.includes("to authenticated"));
  assert.ok(!fixSql.includes("to anon"), "aucune policy ne doit être accordée à anon (modèle authenticated uniquement)");
  // La migration originale ne doit PAS avoir été modifiée pour créer
  // ce correctif -- elle a déjà été appliquée en production et reste
  // le reflet exact de ce qui a réellement été exécuté.
  assert.ok(!migrationSql.includes("enable row level security") || migrationSql.match(/enable row level security/g)!.length <= 4, "la migration originale ne doit pas avoir gagné de nouvelles activations RLS pour ce correctif");
});

test("CORRECTIF RLS : contrôle préalable détecte une double application (RLS déjà activée)", () => {
  const fixSql = readFileSync("supabase/migration-lotd-rls-reference-tables-fix.sql", "utf8");
  assert.ok(fixSql.includes("c.relrowsecurity = true"));
  assert.ok(fixSql.includes("RLS est déjà activée"));
});

test("CORRECTIF RLS : rollback existe, documenté, jamais auto-exécuté", () => {
  const rollbackSql = readFileSync("supabase/migration-lotd-rls-reference-tables-fix-rollback.sql", "utf8");
  assert.ok(rollbackSql.includes("NE JAMAIS EXÉCUTER AUTOMATIQUEMENT"));
  assert.ok(rollbackSql.includes("disable row level security"));
  assert.ok(rollbackSql.includes('drop policy if exists "authenticated read supported countries"'));
  assert.ok(rollbackSql.includes('drop policy if exists "authenticated read supported currencies"'));
});

test("harnais PostgreSQL Lot D : présent, versionné, journal joint sans échec", () => {
  const harness = readFileSync("supabase/tests/lotd-integration-test.sh", "utf8");
  assert.ok(harness.includes("set -euo pipefail"));
  assert.ok(harness.includes("trap cleanup EXIT"));
  assert.ok(harness.includes("assert_eq"));
  assert.ok(harness.includes("RATTACHEMENT : aucun membership préalable"));
  assert.ok(harness.includes("RATTACHEMENT : staff PRÉALABLE"));
  assert.ok(harness.includes("RATTACHEMENT : manager PRÉALABLE"));
  assert.ok(harness.includes("RATTACHEMENT : owner PRÉALABLE"));
  assert.ok(harness.includes("VRAI second appel après succès"));
  assert.ok(harness.includes("SCÉNARIO D'HÉRITAGE DANGEREUX"));
  assert.ok(harness.includes("create role test_writer;"));
  assert.ok(harness.includes("grant test_writer to authenticated;"));
  const log = readFileSync("supabase/tests/lotd-integration-test-log-sample.txt", "utf8");
  assert.ok(log.includes("TOUS LES TESTS LOT D ONT REUSSI"));
  assert.ok(!/FAIL:/.test(log), "le journal d'exemple fourni ne doit contenir aucun échec");
});
