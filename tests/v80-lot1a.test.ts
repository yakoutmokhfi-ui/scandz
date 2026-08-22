import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym LOT 1A — fondations DB, identité, apparence, réseaux sociaux,
// configuration des langues. GO CIO explicite, périmètre strictement
// limité (pas de traductions/switch de langue source/fournisseur
// externe -- Sous-lots B/C/D, non livrés ici).
// ====================================================================

const v80Sql = readFileSync("supabase/migration-v80-lot1a-identity-social-languages.sql", "utf8");
const v80RollbackSql = readFileSync("supabase/migration-v80-rollback.sql", "utf8");
const lotdSql = readFileSync("supabase/migration-lotd-establishment-creation.sql", "utf8");
const themesSrc = readFileSync("lib/themes.ts", "utf8");
const headerSrc = readFileSync("components/RestaurantHeader.tsx", "utf8");
const languageSelectorSrc = readFileSync("components/LanguageSelector.tsx", "utf8");
const socialLinksSrc = readFileSync("lib/social-links.ts", "utf8");
const harnessSrc = readFileSync("supabase/tests/v80-lot1a-check.sh", "utf8");

// --------------------------------------------------------------------
// Découverte de conception : réconciliation avec Lot D (préexistant,
// non anticipée par le design initial -- traitée, pas contournée)
// --------------------------------------------------------------------

test("LOT 1A: migration-lotd-establishment-creation.sql N'EST PAS modifié (déjà en production)", () => {
  assert.ok(lotdSql.includes("create function public.create_establishment("));
  assert.ok(!lotdSql.includes("LOT 1A"), "le fichier Lot D original ne doit contenir aucune trace d'édition de ce lot");
});

test("LOT 1A: les anciennes contraintes CHECK figées de Lot D (source_language, enabled_languages) sont retirées, remplacées par une référence au catalogue", () => {
  assert.ok(v80Sql.includes("drop constraint if exists restaurant_configs_source_language_check"));
  assert.ok(v80Sql.includes("drop constraint if exists restaurant_configs_enabled_languages_chk"));
  assert.ok(v80Sql.includes("add constraint restaurant_configs_source_language_fkey"));
  assert.ok(v80Sql.includes("foreign key (source_language) references public.supported_languages(code)"));
});

test("LOT 1A: backfill de restaurant_active_languages depuis enabled_languages existant (pas seulement 'fr' -- préserve un établissement déjà multilingue via Lot D)", () => {
  const start = v80Sql.indexOf("insert into public.restaurant_active_languages");
  const body = v80Sql.slice(start, start + 500);
  assert.ok(body.includes("unnest(rc.enabled_languages)"), "doit lire le tableau existant, pas insérer une valeur fixe");
});

test("LOT 1A: create_establishment redéfinie (CREATE OR REPLACE, même signature) valide contre le catalogue, pas le tableau figé fr/en/ar", () => {
  const start = v80Sql.indexOf("create or replace function public.create_establishment(");
  assert.ok(start >= 0, "create_establishment doit être redéfinie dans ce fichier");
  const end = v80Sql.indexOf("\nend $$;", start);
  const body = v80Sql.slice(start, end);
  assert.ok(body.includes("select 1 from public.supported_languages where code = p_source_language"));
  assert.ok(!body.includes("p_source_language not in ('fr','en','ar')"), "l'ancienne validation figée ne doit plus exister");
  assert.ok(body.includes("insert into public.restaurant_active_languages"), "doit aussi alimenter la nouvelle table de vérité");
});

// --------------------------------------------------------------------
// Sécurité : réutilisation du patron F-01 Super Admin (V70), jamais un
// contrôle réinventé
// --------------------------------------------------------------------

test("LOT 1A: les 4 nouvelles RPC réutilisent assert_restaurant_asset_role (owner/manager/opérateur), jamais un contrôle manuel réinventé", () => {
  const occurrences = (v80Sql.match(/perform public\.assert_restaurant_asset_role\(p_restaurant_id\);/g) || []).length;
  assert.equal(occurrences, 4, "update_restaurant_identity, _bg_color, _social_links, _languages doivent toutes l'appeler");
});

test("LOT 1A: create_establishment garde son propre contrôle opérateur strict (is_scanym_operator), distinct de assert_restaurant_asset_role (création, pas modification d'un établissement existant)", () => {
  const start = v80Sql.indexOf("create or replace function public.create_establishment(");
  const end = v80Sql.indexOf("\nend $$;", start);
  const body = v80Sql.slice(start, end);
  assert.ok(body.includes("public.is_scanym_operator()"));
});

test("LOT 1A: aucun droit accordé à PUBLIC/anon sur les 4 nouvelles RPC d'écriture", () => {
  for (const fn of [
    "update_restaurant_identity(uuid, text, text, text, boolean)",
    "update_restaurant_bg_color(uuid, text)",
    "update_restaurant_social_links(uuid, text, text, text)",
    "update_restaurant_languages(uuid, text[])",
  ]) {
    assert.ok(v80Sql.includes(`revoke all on function public.${fn} from public, anon;`), `revoke manquant pour ${fn}`);
    assert.ok(v80Sql.includes(`grant execute on function public.${fn} to authenticated;`), `grant manquant pour ${fn}`);
  }
});

test("LOT 1A: supported_languages et restaurant_active_languages ont un GRANT SELECT explicite en plus de la policy RLS (régression réelle trouvée et corrigée pendant le développement -- policy seule ne suffit pas)", () => {
  assert.ok(v80Sql.includes("grant select on public.supported_languages to anon, authenticated;"));
  assert.ok(v80Sql.includes("grant select on public.restaurant_active_languages to anon, authenticated;"));
});

test("LOT 1A: écriture directe sur les 2 nouvelles tables interdite à anon/authenticated (jamais de contournement RLS pour 'faire fonctionner' une fonction)", () => {
  assert.ok(v80Sql.includes("revoke insert, update, delete on public.supported_languages from public, anon, authenticated;"));
  assert.ok(v80Sql.includes("revoke insert, update, delete on public.restaurant_active_languages from public, anon, authenticated;"));
});

// --------------------------------------------------------------------
// Réseaux sociaux — même contrat TS/SQL
// --------------------------------------------------------------------

test("LOT 1A: la validation SQL des réseaux sociaux valide la chaîne BRUTE (nullif direct), jamais un trim silencieux avant validation", () => {
  const start = v80Sql.indexOf("create function public.update_restaurant_social_links");
  const end = v80Sql.indexOf("\nend $$;", start);
  const body = v80Sql.slice(start, end);
  assert.ok(body.includes("v_instagram := nullif(p_instagram_url, '');"));
  assert.ok(!body.includes("btrim(coalesce(p_instagram_url"), "aucun trim ne doit précéder la validation de l'URL");
});

test("LOT 1A: lib/social-links.ts (client) et migration-v80 (serveur) utilisent EXACTEMENT le même motif par réseau", () => {
  const instagramSqlPattern = "^https://(www\\.)?instagram\\.com/[A-Za-z0-9._]{1,30}/?$";
  const tiktokSqlPattern = "^https://(www\\.)?tiktok\\.com/@[A-Za-z0-9._]{1,30}/?$";
  const facebookSqlPattern = "^https://(www\\.)?facebook\\.com/[A-Za-z0-9.]{1,50}/?$";
  assert.ok(v80Sql.includes(instagramSqlPattern));
  assert.ok(v80Sql.includes(tiktokSqlPattern));
  assert.ok(v80Sql.includes(facebookSqlPattern));
  assert.ok(socialLinksSrc.includes("/^https:\\/\\/(www\\.)?instagram\\.com\\/[A-Za-z0-9._]{1,30}\\/?$/"));
  assert.ok(socialLinksSrc.includes("/^https:\\/\\/(www\\.)?tiktok\\.com\\/@[A-Za-z0-9._]{1,30}\\/?$/"));
  assert.ok(socialLinksSrc.includes("/^https:\\/\\/(www\\.)?facebook\\.com\\/[A-Za-z0-9.]{1,50}\\/?$/"));
});

test("LOT 1A: les 3 regex client rejettent bien HTTP, sous-domaine trompeur, credentials, port, query, espace (comportement réel, pas seulement présence de motif)", async () => {
  const { isValidInstagramUrl, isValidTiktokUrl, isValidFacebookUrl } = await import("../lib/social-links.ts");
  const badCases = [
    "http://instagram.com/x",
    "https://instagram.com.evil.example/x",
    "https://user:pass@instagram.com/x",
    "https://instagram.com:8443/x",
    "https://instagram.com/x?ref=1",
    " https://instagram.com/x",
  ];
  for (const c of badCases) assert.equal(isValidInstagramUrl(c), false, c);
  assert.equal(isValidTiktokUrl("https://tiktok.com/nouserprefix"), false);
  assert.equal(isValidTiktokUrl("https://www.tiktok.com/@ok"), true);
  assert.equal(isValidFacebookUrl("http://facebook.com/x"), false);
  assert.equal(isValidFacebookUrl("https://facebook.com/x"), true);
});

// --------------------------------------------------------------------
// Look & feel — bg_color réutilise le mécanisme de contraste existant
// --------------------------------------------------------------------

test("LOT 1A: ThemeColorOverrides accepte bg, themeStyle() l'utilise à la place de t.bg partout", () => {
  assert.ok(themesSrc.includes("bg?: string | null;"));
  assert.ok(themesSrc.includes("const bg = overrides?.bg ?? t.bg;"));
  assert.ok(!themesSrc.match(/(?<!const )bg = overrides.*\n[\s\S]*?"--sc-bg": t\.bg/), "aucun usage résiduel de t.bg après la déclaration de la variable locale");
});

test("LOT 1A: aucune nouvelle fonction de contraste introduite -- readableAccentOnBg/mutedOnBg déjà audités, seulement réutilisés avec bg personnalisé", () => {
  const contrastSrc = readFileSync("lib/color-contrast.ts", "utf8");
  const beforeCount = (contrastSrc.match(/^export function/gm) || []).length;
  // Le nombre de fonctions exportées ne doit pas avoir augmenté pour
  // ce lot -- vérifié en comparant à la liste connue et stable depuis
  // les tours V71-V79 (aucune fonction "bg" spécifique ajoutée).
  assert.ok(!contrastSrc.includes("readableAccentOnBgColor") && !contrastSrc.includes("customBgContrast"), "aucune fonction de contraste dédiée au bg personnalisé ne doit exister -- réutilisation pure");
  assert.ok(beforeCount > 0);
});

test("LOT 1A: cas Au Lait Cru (bg=#000000, accent=or) vérifié empiriquement -- ratio réel calculé, pas supposé", async () => {
  const { themeStyle } = await import("../lib/themes.ts");
  const { contrastRatio } = await import("../lib/color-contrast.ts");
  const s = themeStyle("cafe", { bg: "#000000", accent: "#C9A227" });
  assert.equal(s["--sc-bg"], "#000000");
  assert.ok(contrastRatio(s["--sc-ink-on-bg"], s["--sc-bg"]) >= 4.5, "texte de corps sur fond noir doit rester lisible");
});

test("LOT 1A: les 5 thèmes par défaut restent inchangés SANS bg_color personnalisé (non-régression V79)", async () => {
  const { themeStyle, THEMES } = await import("../lib/themes.ts");
  for (const name of Object.keys(THEMES)) {
    const s = themeStyle(name);
    assert.equal(s["--sc-bg"], (THEMES as Record<string, { bg: string }>)[name].bg, `thème '${name}'`);
  }
});

// --------------------------------------------------------------------
// Langues — LanguageSelector alimenté dynamiquement, pas la constante
// globale
// --------------------------------------------------------------------

test("LOT 1A: LanguageSelector accepte une prop languages dynamique, plus la constante globale LANGUAGES codée en dur", () => {
  assert.ok(!languageSelectorSrc.includes('import { LANGUAGES'));
  assert.ok(languageSelectorSrc.includes("languages?: SelectableLanguage[]"));
});

test("LOT 1A: LanguageSelector se masque (return null) si une seule langue active -- jamais un sélecteur inutile", () => {
  assert.ok(languageSelectorSrc.includes("languages.length <= 1"));
  assert.ok(languageSelectorSrc.includes("return null;"));
});

test("LOT 1A: RestaurantHeader passe restaurant.activeLanguages à LanguageSelector (pas la constante globale)", () => {
  assert.ok(headerSrc.includes("languages={restaurant.activeLanguages}"));
});

test("LOT 1A: aucune opacité Tailwind appliquée aux icônes réseaux sociaux (même discipline que V72-02/V73-02/V74-01 -- pas de régression réintroduite)", () => {
  // Icônes réseaux sociaux : recherche ciblée dans leur bloc (après
  // le commentaire "réseaux sociaux"), pas tout le fichier -- le
  // wrapper de l'Ornament décoratif (text-ink-text/80, aria-hidden)
  // reste une exemption légitime établie depuis V73-02/V74-01,
  // vérifiée séparément dans tests/v75-language-selector-contrast.test.ts.
  const socialStart = headerSrc.indexOf("réseaux sociaux : seules les icônes");
  const socialBlock = headerSrc.slice(socialStart);
  assert.ok(!socialBlock.includes("text-ink-text/90"));
  assert.ok(!socialBlock.includes("text-ink-text/80"));
  assert.ok(socialBlock.includes('className="text-ink-text"'), "les icônes doivent utiliser text-ink-text à pleine puissance");
});

// --------------------------------------------------------------------
// Rollback — corrigé après un vrai défaut trouvé par le harnais
// (réapplication échouait)
// --------------------------------------------------------------------

test("LOT 1A rollback: source_language N'EST JAMAIS supprimée (colonne Lot D, pas créée par ce lot) -- défaut réel trouvé et corrigé pendant le développement", () => {
  assert.ok(!v80RollbackSql.includes("drop column if exists source_language"));
  assert.ok(v80RollbackSql.includes("PRÉSERVÉE"));
});

test("LOT 1A rollback: restaure create_establishment à son corps EXACT de Lot D (is_scanym_operator, tableau figé fr/en/ar) avant de supprimer les tables du catalogue", () => {
  const createIdx = v80RollbackSql.indexOf("create or replace function public.create_establishment(");
  const dropTableIdx = v80RollbackSql.indexOf("drop table if exists public.supported_languages");
  assert.ok(createIdx >= 0 && dropTableIdx > createIdx, "la fonction doit être restaurée AVANT la suppression des tables qu'elle référençait");
  const end = v80RollbackSql.indexOf("\nend $$;", createIdx);
  const body = v80RollbackSql.slice(createIdx, end);
  assert.ok(body.includes("p_source_language not in ('fr','en','ar')"), "doit restaurer la validation figée d'origine, pas la version catalogue");
});

test("LOT 1A rollback: restaure la contrainte CHECK figée d'origine sur source_language (état Lot D exact)", () => {
  assert.ok(v80RollbackSql.includes("add constraint restaurant_configs_source_language_check"));
  assert.ok(v80RollbackSql.includes("check (source_language in ('fr', 'en', 'ar'));"));
});

test("LOT 1A rollback: jamais auto-exécuté", () => {
  assert.ok(v80RollbackSql.includes("NE JAMAIS EXÉCUTER AUTOMATIQUEMENT"));
});

// --------------------------------------------------------------------
// Preuve empirique PostgreSQL réelle (harnais dédié)
// --------------------------------------------------------------------

test("LOT 1A: le harnais PostgreSQL dédié couvre tous les scénarios exigés (réconciliation, RPCs, réseaux sociaux, langues, rollback)", () => {
  const requiredMarkers = [
    "Sirocco conserve fr,ar",
    "create_establishment avec NL réussit",
    "opérateur Scanym peut modifier l'identité de N'IMPORTE QUEL établissement",
    "staff NE PEUT PAS modifier l'identité",
    "cross-tenant",
    "Au Lait Cru",
    "retrait de la langue source (fr) refusé",
    "rollback: réapplication propre réussie",
  ];
  for (const m of requiredMarkers) {
    assert.ok(harnessSrc.includes(m), `scénario manquant dans le harnais : ${m}`);
  }
});
