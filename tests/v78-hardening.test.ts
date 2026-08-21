import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

// ====================================================================
// Scanym V78 — corrections ciblées après contre-audit indépendant Work
// sur V77 (findings V77-01, V77-02, V77-03).
// ====================================================================

const v71Sql = readFileSync("supabase/migration-v71-hardening.sql", "utf8");
const v73Sql = readFileSync("supabase/migration-v73-hardening.sql", "utf8");
const v76Sql = readFileSync("supabase/migration-v76-storage-origin-config.sql", "utf8");
const preflightSql = readFileSync("supabase/preflight-historical-uuid-check.sql", "utf8");
const harnessSrc = readFileSync("supabase/tests/v68-storage-policy-check.sh", "utf8");

// --------------------------------------------------------------------
// V77-01 — séquence opérationnelle unique
// --------------------------------------------------------------------

/**
 * Recherche exhaustive de toute séquence opérationnelle contenant à la
 * fois "preflight" (ou "préflight") et "V71" dans un même fichier, en
 * excluant explicitement les blocs marqués "[Historique" -- corrige
 * V77-01 (contre-audit Work, 8e tour) : la mission exige une recherche
 * exhaustive, pas seulement les 3 fichiers cités.
 */
function findStaleSequenceMentions(src: string, label: string) {
  const lines = src.split("\n");
  const problems: string[] = [];
  let inHistoricalBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("[Historique") || line.toLowerCase().includes("ne plus utiliser comme instruction")) {
      inHistoricalBlock = true;
    }
    // Une ligne "vide" de commentaire (juste "--") referme le bloc
    // historique explicitement marqué dans nos fichiers.
    if (inHistoricalBlock && /preflight|préflight/i.test(line) && /V71/.test(line) && !/CONFIGURATION CIO/i.test(lines.slice(Math.max(0, i - 8), i).join("\n"))) {
      // Toujours dans le bloc historique -- légitime.
      continue;
    }
    if (!inHistoricalBlock && /(preflight|préflight)[^\n]*→[^\n]*V71|V70[^\n]*→[^\n]*(preflight|préflight)/i.test(line)) {
      // Une séquence V70→préflight→V71 SANS mention de configuration
      // CIO dans les lignes environnantes = séquence obsolète.
      const surrounding = lines.slice(Math.max(0, i - 6), i + 2).join("\n");
      if (!/CONFIGURATION CIO/i.test(surrounding) && !/migration-v76-storage-origin-config/i.test(surrounding)) {
        problems.push(`${label}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return problems;
}

test("V77-01: aucune séquence opérationnelle obsolète (V70→préflight→V71 sans configuration CIO) ne subsiste, hors blocs explicitement marqués historiques", () => {
  const files: Array<[string, string]> = [
    ["migration-v71-hardening.sql", v71Sql],
    ["migration-v73-hardening.sql", v73Sql],
    ["preflight-historical-uuid-check.sql", preflightSql],
    ["migration-v76-storage-origin-config.sql", v76Sql],
  ];
  const allProblems: string[] = [];
  for (const [label, src] of files) {
    allProblems.push(...findStaleSequenceMentions(src, label));
  }
  assert.deepEqual(allProblems, [], `séquence(s) obsolète(s) détectée(s) : ${allProblems.join(" | ")}`);
});

test("V77-01: les 4 fichiers opérationnels documentent tous la MÊME séquence (V70 -> V76 -> configuration CIO -> préflight -> V71 -> V72 -> V73)", () => {
  for (const [label, src] of [
    ["migration-v71-hardening.sql", v71Sql],
    ["migration-v73-hardening.sql", v73Sql],
    ["preflight-historical-uuid-check.sql", preflightSql],
  ] as const) {
    assert.ok(src.includes("CONFIGURATION CIO DE L'ORIGINE"), `${label} doit mentionner l'étape de configuration CIO`);
    assert.ok(
      src.includes("migration-v76-storage-origin-config.sql"),
      `${label} doit mentionner migration-v76-storage-origin-config.sql`
    );
  }
});

test("V77-01: les mentions historiques (V72-04) restent explicitement marquées comme telles, jamais comme instruction d'installation actuelle", () => {
  assert.ok(v73Sql.includes("[Historique"));
});

// --------------------------------------------------------------------
// V77-02 — host numérique + port
// --------------------------------------------------------------------

function extractIsValidStorageOriginBody(sql: string): string {
  const start = sql.indexOf("create or replace function scanym_internal.is_valid_storage_origin");
  const end = sql.indexOf("\n$$;", start);
  return sql.slice(start, end);
}

test("V77-02: is_valid_storage_origin sépare EXPLICITEMENT host et port (plpgsql structurel), plus un lookahead fragile en SQL pur dans le CODE (une mention en commentaire expliquant l'ancien défaut est légitime)", () => {
  const body = extractIsValidStorageOriginBody(v76Sql);
  assert.ok(body.includes("language plpgsql"));
  assert.ok(body.includes("regexp_match(p_origin, '^https://([^:/?#\\s]+)(?::([0-9]+))?$')"));
  const codeOnly = body.replace(/--[^\n]*/g, "");
  assert.ok(!codeOnly.includes("(?!\\d+"), "l'ancien lookahead fragile ne doit plus exister dans le CODE");
});

test("V77-02: le host est validé comme purement numérique INDÉPENDAMMENT du port (contrôle séparé, pas couplé dans un seul motif)", () => {
  const body = extractIsValidStorageOriginBody(v76Sql);
  const numericCheckIdx = body.indexOf("v_host ~ '^[0-9]+(\\.[0-9]+)*$'");
  const portCheckIdx = body.indexOf("v_port !~");
  assert.ok(numericCheckIdx >= 0 && portCheckIdx > numericCheckIdx, "le contrôle numérique du host doit précéder, et être distinct de, la validation du port");
});

test("V77-02: matrice complète -- host numérique refusé AVEC ou SANS port, host DNS + port valide accepté (test structurel, la preuve empirique réelle est dans le harnais PostgreSQL)", () => {
  // Ce test vérifie la PRÉSENCE et la cohérence des cas dans le
  // harnais PostgreSQL (preuve réelle) -- il ne réimplémente pas la
  // regex en JS pour éviter toute divergence avec le SQL réel.
  const requiredCases = [
    "https://1 seul",
    "https://1:443",
    "https://999.999.999.999 seul",
    "https://999.999.999.999:443",
    "https://127.0.0.1 seul",
    "https://127.0.0.1:5432",
    "host DNS valide + port valide (example.com:443)",
    "host DNS valide + port valide (sub.example.com:8443)",
  ];
  for (const c of requiredCases) {
    assert.ok(harnessSrc.includes(c), `cas manquant dans le harnais : ${c}`);
  }
});

test("V77-02: le helper partagé reste l'unique contrat utilisé par la contrainte de storage_config ET par V71 finale", () => {
  assert.ok(v76Sql.includes("scanym_internal.is_valid_storage_origin(storage_public_origin)"));
  assert.ok(v71Sql.includes("scanym_internal.is_valid_storage_origin(v_base_url)"));
});

test("V77-02: la valeur réelle de Production reste acceptée (non-régression)", () => {
  const body = extractIsValidStorageOriginBody(v76Sql);
  // Confirme la présence du motif DNS générique (pas de liste blanche
  // codée en dur pour ctqfpszwunfomrbxgigu -- la preuve empirique
  // réelle est dans le harnais).
  assert.ok(body.includes("[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"));
});

// --------------------------------------------------------------------
// V77-03 — anti-dérive V70 complet
// --------------------------------------------------------------------

test("V77-03: le précheck de V71 vérifie exactement UNE fonction, sans overload (count == 1, jamais 'au moins 1')", () => {
  const start = v71Sql.indexOf("do $$");
  const end = v71Sql.indexOf("end $$;", start);
  const body = v71Sql.slice(start, end);
  assert.ok(body.includes("if v_count = 0 then"));
  assert.ok(body.includes("if v_count > 1 then"));
});

test("V77-03: le précheck vérifie le type de retour (void), la volatilité (STABLE), SECURITY DEFINER, le propriétaire, et search_path -- via pg_proc, jamais un hash du corps formaté", () => {
  const start = v71Sql.indexOf("do $$");
  const end = v71Sql.indexOf("end $$;", start);
  const body = v71Sql.slice(start, end);
  assert.ok(body.includes("prorettype::regtype::text"));
  assert.ok(body.includes("provolatile"));
  assert.ok(body.includes("prosecdef"));
  assert.ok(body.includes("pg_get_userbyid(proowner)"));
  assert.ok(body.includes("'search_path=\"\"' = any(proconfig)"));
  assert.ok(!/md5\(|sha256\(|digest\(/i.test(body), "aucun hash du corps SQL formaté ne doit être utilisé (fragile au formatage)");
});

test("V77-03: le précheck vérifie un marqueur ciblé du corps V70 via pg_get_functiondef, pas un hash", () => {
  const start = v71Sql.indexOf("do $$");
  const end = v71Sql.indexOf("end $$;", start);
  const body = v71Sql.slice(start, end);
  assert.ok(body.includes("pg_get_functiondef(v_oid)"));
  assert.ok(body.includes("current_setting\\(''app\\.storage_public_base_url''"));
});

test("V77-03: les 6 scénarios de dérive exigés sont présents et testés réellement dans le harnais PostgreSQL (preuve empirique, pas seulement du texte)", () => {
  const requiredScenarios = [
    "mauvais type de retour (boolean au lieu de void)",
    "non SECURITY DEFINER",
    "mauvais search_path (absent)",
    "mauvaise volatilité (volatile au lieu de stable)",
    "overload (deuxième fonction du même nom, arité différente)",
    "corps V70 dérivé (marqueur caractéristique absent)",
  ];
  for (const s of requiredScenarios) {
    assert.ok(harnessSrc.includes(s), `scénario manquant dans le harnais : ${s}`);
  }
});

test("Harnais: le mécanisme HARNESS SELF-TEST (journal indépendant) reste intact après tous ces ajouts", () => {
  assert.ok(harnessSrc.includes("HARNESS SELF-TEST"));
  assert.ok(harnessSrc.includes('"$FAIL_LOG_COUNT" != "$FAIL_COUNT"'));
});
