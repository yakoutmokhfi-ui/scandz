import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const {
  EMPTY_INVOICE_REQUEST,
  INVOICE_FIELD_MAX_LENGTHS,
  composeBillingContactName,
  getInvoiceRequestErrors,
  hasInvoiceRequestErrors,
  normalizeOptional,
} = await import("../lib/invoice-request.ts");
import type { InvoiceRequestInfo } from "../lib/invoice-request.ts";
const { COMMUNICATION_TEXT_KEYS, COMMUNICATION_TEXT_SPEC, PUBLIC_COMMUNICATION_TEXT_KEYS } = await import(
  "../lib/communications/text-keys.ts"
);
const { resolveCommunicationText } = await import("../lib/communications/resolve.ts");
const { translate } = await import("../lib/i18n.ts");

// ====================================================================
// Scanym — CUSTOMER BILLING PROFILE v2 (Claude Monet)
//
// Ce lot n'invente PAS une identité de facturation : elle existe déjà
// (`order_invoice_request`, 1:1 avec `orders`, écrite par la seule RPC
// `set_order_invoice_request` sur preuve de possession anonyme). Il la
// COMPLÈTE sur trois points, et ces tests verrouillent exactement
// cela :
//
//   - un SIREN OPTIONNEL, à côté du numéro de TVA déjà optionnel ;
//   - un prénom et un nom saisis SÉPARÉMENT pour une facturation
//     particulier, RECOMPOSÉS dans la colonne `contact_name`
//     existante (jamais une colonne de plus) ;
//   - un texte d'explication CONFIGURABLE PAR LE COMMERÇANT, pris
//     dans le catalogue FERMÉ déjà en place.
//
// RÈGLES PRODUIT NON NÉGOCIABLES, chacune couverte ci-dessous :
// SIREN optionnel, TVA optionnelle, AUCUN SIRET, aucune inférence
// d'un identifiant vers un autre, aucun appel de registre, aucune
// « correction » de la saisie du client.
// ====================================================================

const repoRoot = process.cwd();
const read = (...parts: string[]) => readFileSync(path.join(repoRoot, ...parts), "utf8");
const SQL = read("supabase", "DRAFT-lot-customer-billing-profile-v2.sql");
const SQL_ROLLBACK = read("supabase", "DRAFT-lot-customer-billing-profile-v2-rollback.sql");
const flat = (value: string) => value.replace(/\s+/g, " ");

/** SQL réellement EXÉCUTÉ : commentaires `--` retirés. Les fichiers de
 *  ce dépôt DOCUMENTENT leurs interdits en toutes lettres (« jamais un
 *  SIRET »…) ; chercher ces mots dans le texte brut ferait échouer un
 *  test précisément parce que la garantie est écrite. */
const executable = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

/** Profil de facturation complet, particulier. */
function individual(over: Partial<InvoiceRequestInfo> = {}): InvoiceRequestInfo {
  return {
    ...EMPTY_INVOICE_REQUEST,
    wantsInvoice: true,
    invoiceType: "individual",
    firstName: "Victor",
    lastName: "Hugo",
    addressLine1: "6 place des Vosges",
    city: "Paris",
    postalCode: "75004",
    country: "FR",
    contactEmail: "victor.hugo@example.org",
    ...over,
  };
}

/** Profil de facturation complet, société. */
function company(over: Partial<InvoiceRequestInfo> = {}): InvoiceRequestInfo {
  return {
    ...EMPTY_INVOICE_REQUEST,
    wantsInvoice: true,
    invoiceType: "company",
    companyLegalName: "Maison Hugo SARL",
    addressLine1: "6 place des Vosges",
    city: "Paris",
    postalCode: "75004",
    country: "FR",
    siren: "123456789",
    vatNumber: "FR12345678901",
    ...over,
  };
}

// ==================================================================
// 1. PROFIL PARTICULIER
// ==================================================================

test("particulier : prénom, nom, adresse, code postal, ville et pays suffisent", () => {
  const info = individual();
  assert.deepEqual(getInvoiceRequestErrors(info), {});
  assert.equal(hasInvoiceRequestErrors(info), false);
});

test("particulier : prénom et nom se RECOMPOSENT dans le champ de contact existant", () => {
  assert.equal(composeBillingContactName(individual()), "Victor Hugo");
  // Un seul des deux suffit -- aucune obligation nouvelle.
  assert.equal(composeBillingContactName(individual({ lastName: "" })), "Victor");
  assert.equal(composeBillingContactName(individual({ firstName: "" })), "Hugo");
});

test("particulier : sans prénom ni nom, la valeur historique de contactName est rendue TELLE QUELLE", () => {
  // Compatibilité arrière : un parcours antérieur à ce lot ne
  // renseignait qu'un champ unique -- il continue de fonctionner.
  const legacy = individual({ firstName: "", lastName: "", contactName: "Service comptabilité" });
  assert.equal(composeBillingContactName(legacy), "Service comptabilité");
  assert.deepEqual(getInvoiceRequestErrors(legacy), {});
});

test("particulier : AUCUN champ société n'est requis ni transmis", () => {
  const info = individual();
  assert.equal(info.companyLegalName, "");
  assert.equal(info.siren, "");
  assert.equal(info.vatNumber, "");
  assert.deepEqual(getInvoiceRequestErrors(info), {});
});

// ==================================================================
// 2. PROFIL SOCIÉTÉ — et l'optionalité des identifiants
// ==================================================================

test("société : raison sociale, adresse, SIRET et TVA -> valide", () => {
  assert.deepEqual(getInvoiceRequestErrors(company()), {});
});

// UX LOT 2026-10 (demande Emmanuel) : le champ `siren` porte le SIRET
// et devient REQUIS pour une facture entreprise -- PRÉSENCE seulement.
// Remplace la règle v2 « société SANS SIREN -> valide ».
test("société SANS SIRET -> refusée (invoiceSiretRequired), et rien d'autre", () => {
  const info = company({ siren: "" });
  assert.deepEqual(getInvoiceRequestErrors(info), { siren: "invoiceSiretRequired" });
  assert.equal(hasInvoiceRequestErrors(info), true);
  assert.equal(normalizeOptional(info.siren), undefined, "un SIRET vide n'est jamais transmis");
});

test("société avec SIRET composé de blancs seulement -> refusée (présence = non vide après trim)", () => {
  assert.deepEqual(getInvoiceRequestErrors(company({ siren: "   " })), { siren: "invoiceSiretRequired" });
});

test("particulier : le SIRET n'est jamais exigé (champ sans objet)", () => {
  assert.deepEqual(getInvoiceRequestErrors(individual({ siren: "" })), {});
});

test("société SANS numéro de TVA -> valide", () => {
  assert.deepEqual(getInvoiceRequestErrors(company({ vatNumber: "" })), {});
});

test("société avec SIRET mais SANS TVA -> valide (la TVA reste optionnelle)", () => {
  const info = company({ vatNumber: "" });
  assert.deepEqual(getInvoiceRequestErrors(info), {});
  assert.equal(hasInvoiceRequestErrors(info), false);
});

test("société : raison sociale ET SIRET requis -- aucune autre obligation nouvelle", () => {
  const errors = getInvoiceRequestErrors(company({ companyLegalName: "", siren: "" }));
  assert.equal(errors.companyLegalName, "invoiceCompanyNameRequired");
  assert.equal(errors.siren, "invoiceSiretRequired");
  assert.deepEqual(Object.keys(errors).sort(), ["companyLegalName", "siren"]);
});

test("les champs optionnels le restent : aucun d'eux ne produit d'erreur à vide", () => {
  const minimal: InvoiceRequestInfo = {
    ...EMPTY_INVOICE_REQUEST,
    wantsInvoice: true,
    invoiceType: "individual",
    addressLine1: "6 place des Vosges",
    city: "Paris",
    postalCode: "75004",
    country: "FR",
  };
  // siren, vatNumber, firstName, lastName, contactName, contactEmail,
  // addressLine2 : tous vides.
  assert.deepEqual(getInvoiceRequestErrors(minimal), {});
});

test("un SIRET trop long est refusé en LONGUEUR seulement -- jamais en format", () => {
  const errors = getInvoiceRequestErrors(company({ siren: "1".repeat(INVOICE_FIELD_MAX_LENGTHS.siren + 1) }));
  assert.equal(errors.siren, "invoiceSirenTooLong");
  // Une valeur « mal formée » mais courte passe : ce n'est pas à la
  // plateforme de juger de la forme d'un identifiant déclaré.
  assert.deepEqual(getInvoiceRequestErrors(company({ siren: "abc-123" })), {});
  assert.deepEqual(getInvoiceRequestErrors(company({ siren: "123 456 789" })), {});
});

// ==================================================================
// 3. AUCUN SIRET, AUCUNE INFÉRENCE, AUCUNE CORRECTION
// ==================================================================

test("le SIRET est porté par le champ/la colonne historiques `siren` : aucune colonne, aucun paramètre SIRET déclaré (aucune migration)", () => {
  // UX LOT 2026-10 : le SIRET remplace le SIREN dans l'INTERFACE et la
  // règle de validation, mais le contrat de stockage reste `siren`
  // (aucune migration hébergée). Le type de saisie, la table et les
  // deux RPC : aucune déclaration SIRET.
  assert.ok(!("siret" in EMPTY_INVOICE_REQUEST));
  // Le SQL du lot MENTIONNE « siret » à trois endroits, et ces trois
  // endroits sont des GARDES : deux vérifications qui REFUSENT un
  // schéma où une colonne SIRET aurait été glissée, et un postcheck
  // qui refuse une RPC qui en parlerait. Ce qu'il faut interdire, ce
  // sont les DÉCLARATIONS -- colonne, paramètre, variable -- pas les
  // protections qui les empêchent.
  const sqlCode = executable(SQL);
  assert.ok(!/add column[^;]*siret/i.test(sqlCode), "aucune colonne SIRET déclarée");
  assert.ok(!/p_siret|v_siret/i.test(sqlCode), "aucun paramètre ni variable SIRET");
  // …et les gardes, elles, existent bel et bien.
  assert.match(sqlCode, /column_name like '%siret%'/);
  // lib/invoice-request.ts porte désormais la clé d'erreur
  // `invoiceSiretRequired` (règle de présence) : il est volontairement
  // exclu de ce balayage ; service et route n'ont toujours aucun
  // identifiant SIRET exécutable (ils transmettent `siren`).
  const service = read("lib", "server", "invoice-request-service.ts");
  const route = read("app", "api", "checkout", "invoice-request", "route.ts");
  for (const [name, source] of [
    ["lib/server/invoice-request-service.ts", service],
    ["app/api/checkout/invoice-request/route.ts", route],
  ] as const) {
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
      .join("\n");
    assert.ok(!/siret/i.test(code), `${name} ne doit porter aucun SIRET exécutable`);
  }
});

test("aucune dérivation d'un identifiant vers un autre", () => {
  const code = executable(SQL);
  // Ni SIRET depuis SIREN, ni TVA depuis SIREN : les trois champs sont
  // lus, bornés, écrits -- jamais calculés l'un depuis l'autre.
  assert.ok(!/v_vat_number\s*:=\s*[^;]*v_siren/.test(code));
  assert.ok(!/v_siren\s*:=\s*[^;]*v_vat_number/.test(code));
  // La seule affectation de v_siren est la lecture du paramètre.
  const assignments = code.match(/v_siren\s*:=\s*[^;]+;/g) ?? [];
  assert.deepEqual(assignments, ["v_siren := nullif(btrim(coalesce(p_siren, '')), '');"]);
});

test("aucun appel de registre d'entreprises, nulle part dans le lot", () => {
  const touched = [
    read("lib", "invoice-request.ts"),
    read("lib", "services", "invoice-request.ts"),
    read("lib", "server", "invoice-request-service.ts"),
    read("app", "api", "checkout", "invoice-request", "route.ts"),
    read("components", "InvoiceRequestFields.tsx"),
    SQL,
  ].join("\n");
  for (const registry of ["insee", "sirene", "api.gouv", "pappers", "infogreffe", "opencorporates"]) {
    assert.ok(!new RegExp(registry, "i").test(touched), `aucun appel à ${registry}`);
  }
});

test("la saisie du client n'est jamais « corrigée » : seul le blanc de bordure est retiré", () => {
  // Côté client : normalizeOptional ne fait qu'un trim.
  assert.equal(normalizeOptional("  123 456 789  "), "123 456 789");
  assert.equal(normalizeOptional("fr 12 345"), "fr 12 345", "aucune mise en majuscules, aucun retrait d'espace interne");
  // Côté SQL : btrim seul, et aucune autre transformation du SIREN.
  const code = flat(executable(SQL));
  assert.match(code, /v_siren := nullif\(btrim\(coalesce\(p_siren, ''\)\), ''\);/);
  assert.ok(!/upper\(\s*(coalesce\(\s*)?p_siren/i.test(code), "aucune normalisation de casse du SIREN");
  assert.ok(!/replace\([^)]*p_siren/i.test(code), "aucun retrait de caractères dans le SIREN");
  assert.ok(!/regexp_replace\([^)]*siren/i.test(code), "aucune réécriture du SIREN");
  // …et aucun contrôle de format n'est appliqué au SIREN.
  assert.ok(!/p_siren[^;]*!~/.test(code) && !/v_siren[^;]*!~/.test(code), "aucun contrôle d'expression régulière sur le SIREN");
});

// ==================================================================
// 4. INSTANTANÉ HISTORIQUE DE LA COMMANDE
// ==================================================================

test("instantané : le profil de facturation est porté PAR LA COMMANDE, jamais par un profil central", () => {
  const foundation = read("supabase", "DRAFT-lot-invoice-request-foundation-v1.sql");
  // 1:1 avec orders, clé primaire = order_id : il n'existe aucune
  // table de profil client réutilisable, donc rien à redériver.
  assert.match(flat(foundation), /order_id\s+uuid primary key references public\.orders\(id\) on delete cascade/);
  // Et il n'existe AUCUNE table de profil de facturation réutilisable
  // d'une commande à l'autre : c'est structurellement ce qui rend
  // l'instantané stable -- il n'y a rien à redériver.
  assert.ok(
    !/create table public\.(customer|client)_?(billing|invoice)_?profile/i.test(foundation),
    "aucun profil de facturation central"
  );
  // La seule source d'adresse de facturation est la ligne de la
  // commande elle-même : la table ne référence ni order_billing_context
  // (paiement) ni order_delivery_address.
  const ddl = foundation.slice(
    foundation.indexOf("create table public.order_invoice_request"),
    foundation.indexOf("comment on table public.order_invoice_request")
  );
  const ddlCode = ddl
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.ok(!ddlCode.includes("order_billing_context"));
  assert.ok(!ddlCode.includes("order_delivery_address"));
});

test("instantané : ce lot n'ajoute AUCUN chemin d'écriture, ni déclencheur, ni recalcul", () => {
  const code = executable(SQL);
  // Une seule voie d'écriture : la RPC existante, étendue.
  assert.ok(!/create\s+trigger/i.test(code), "aucun déclencheur ajouté");
  assert.ok(!/create\s+table/i.test(code), "aucune table ajoutée");
  // Aucune mise à jour de masse : pas de backfill déguisé.
  assert.ok(!/update\s+public\.order_invoice_request\s+set/i.test(code), "aucune réécriture de lignes existantes");
  assert.ok(!/update\s+public\.orders/i.test(code), "orders n'est jamais modifiée");
  // La seule écriture est l'upsert de la RPC, déclenché par le client
  // porteur du couple (order_id, public_token).
  assert.match(flat(code), /on conflict \(order_id\) do update set/);
  assert.match(flat(code), /where o\.id = p_order_id and o\.public_token = p_public_token/);
});

test("instantané : une modification ultérieure du catalogue/profil marchand ne peut pas atteindre une commande", () => {
  // Le lot ne lit AUCUNE table marchande dans la RPC d'écriture : ni
  // profil légal du vendeur, ni configuration d'établissement.
  const rpcBody = SQL.slice(
    SQL.indexOf("create function public.set_order_invoice_request"),
    SQL.indexOf("comment on function public.set_order_invoice_request")
  );
  for (const forbidden of ["merchant_legal_profile", "restaurant_configs", "merchant_cgv_profile", "menu_items"]) {
    assert.ok(!rpcBody.includes(forbidden), `la RPC d'écriture ne doit pas lire ${forbidden}`);
  }
});

// ==================================================================
// 5. ISOLATION MULTI-LOCATAIRE
// ==================================================================

test("isolation : la posture de privilèges et la RLS existantes sont RÉAFFIRMÉES, jamais élargies", () => {
  const code = flat(executable(SQL));
  // Les RPC restent réservées à service_role après le DROP/CREATE.
  assert.match(code, /revoke all on function public\.set_order_invoice_request\(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.set_order_invoice_request\(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text\) to service_role;/);
  assert.match(code, /revoke all on function public\.get_order_invoice_request\(uuid, uuid\) from public, anon, authenticated;/);
  assert.match(code, /grant execute on function public\.get_order_invoice_request\(uuid, uuid\) to service_role;/);
  // Aucun GRANT à anon/authenticated nulle part dans le lot.
  assert.ok(!/grant\s+execute[^;]*to\s+(anon|authenticated)/i.test(code.replace(/public_communication_text_keys[^;]*;/g, "")));
  // Aucune policy ni RLS touchée.
  assert.ok(!/create\s+policy|drop\s+policy|alter\s+table[^;]*(enable|disable)\s+row\s+level\s+security/i.test(code));
  // Les postchecks VÉRIFIENT la posture plutôt que de la supposer.
  assert.match(code, /has_table_privilege\('anon', 'public\.order_invoice_request', 'select'\)/);
  assert.match(code, /order_invoice_request_select_staff/);
  assert.match(code, /relrowsecurity/);
});

test("isolation : la lecture marchande reste filtrée par établissement", () => {
  const dashboard = read("lib", "services", "dashboard.ts");
  // La requête qui porte désormais `siren` est la MÊME, filtrée par
  // restaurant_id -- aucun nouveau chemin de lecture n'est ouvert.
  assert.match(flat(dashboard), /order_invoice_request \( invoice_type, company_legal_name, vat_number, siren, contact_name/);
  assert.match(dashboard, /\.eq\("restaurant_id", restaurantId\)/);
});

// ==================================================================
// 6. COMPATIBILITÉ ARRIÈRE
// ==================================================================

test("compatibilité : la colonne SIREN est NULLABLE, sans défaut, et aucun backfill n'est fait", () => {
  const code = flat(executable(SQL));
  assert.match(code, /add column siren text check \(siren is null or length\(siren\) between 1 and 14\)/);
  assert.ok(!/add column siren[^;]*not null/i.test(code), "jamais NOT NULL");
  assert.ok(!/add column siren[^;]*default/i.test(code), "jamais de valeur par défaut");
  // Le postcheck l'exige explicitement.
  assert.match(code, /column_name = 'siren' and is_nullable = 'YES' and column_default is null/);
});

test("compatibilité : le nouveau paramètre est OPTIONNEL et en DERNIÈRE position", () => {
  const signature = SQL.slice(
    SQL.indexOf("create function public.set_order_invoice_request"),
    SQL.indexOf("returns table (\n  order_id      uuid,")
  );
  assert.match(signature, /p_siren\s+text default null/);
  // Dernier paramètre déclaré : un appelant antérieur (12 arguments
  // nommés) continue de fonctionner, SIREN restant NULL.
  const params = [...signature.matchAll(/^\s{2}(p_[a-z_0-9]+)\s/gm)].map((m) => m[1]);
  assert.equal(params[params.length - 1], "p_siren");
  assert.equal(params.length, 13);
});

test("compatibilité : une lecture sans colonne `siren` retombe sur « non renseigné »", () => {
  const service = read("lib", "server", "invoice-request-service.ts");
  assert.match(service, /siren: row\.siren \?\? null,/);
});

test("compatibilité : le type marchand garde la clé optionnelle (aucune fixture antérieure invalidée)", () => {
  const types = read("lib", "dashboard-types.ts");
  assert.match(types, /siren\?: string \| null;/);
});

// ==================================================================
// 7. NON-RÉGRESSION DU PARCOURS DE DEMANDE DE FACTURE
// ==================================================================

test("régression : AUCUN second mécanisme de demande de facture", () => {
  // Une seule route d'écriture, une seule paire de RPC, un seul
  // service serveur -- ce lot n'en ajoute aucun.
  const code = executable(SQL);
  const created = [...code.matchAll(/create (?:or replace )?function public\.([a-z_0-9]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(created)].sort(),
    ["communication_text_keys", "get_order_invoice_request", "public_communication_text_keys", "set_order_invoice_request"],
    "le lot ne crée que les fonctions EXISTANTES qu'il étend"
  );
});

test("régression : la validation de format d'e-mail du delta est PRÉSERVÉE dans le nouveau corps", () => {
  const code = flat(executable(SQL));
  assert.match(code, /if v_contact_email is not null and v_contact_email !~ '\^\[\^@\[:space:\]\]\+@\[\^@\[:space:\]\]\+\\\.\[A-Za-z\]\{2,\}\$' then/);
  assert.match(code, /p_contact_email invalide/);
  // Et le pré-vol REFUSE de s'appliquer sur une version qui ne la
  // porterait pas (sinon ce fichier l'effacerait).
  assert.match(code, /ne porte pas la validation d''e-mail|ne porte pas la validation de format d''e-mail/);
});

test("régression : toutes les règles antérieures de la RPC sont reprises à l'identique", () => {
  const code = flat(executable(SQL));
  for (const rule of [
    "p_address_line_1 requis",
    "p_city requis",
    "p_postal_code requis",
    "p_country doit être un code ISO 3166-1 alpha-2",
    "p_company_legal_name requis lorsque p_invoice_type = ''company''",
    "p_vat_number dépasse 30 caractères",
    "p_contact_name dépasse 45 caractères",
    "p_contact_email dépasse 100 caractères",
  ]) {
    assert.ok(code.includes(rule), `règle antérieure absente : ${rule}`);
  }
});

test("régression : les bornes clientes restent le miroir exact des contraintes SQL", () => {
  assert.equal(INVOICE_FIELD_MAX_LENGTHS.siren, 14);
  assert.match(flat(executable(SQL)), /length\(siren\) between 1 and 14/);
  assert.match(flat(executable(SQL)), /p_siren dépasse 14 caractères/);
});

// ==================================================================
// 8. TEXTE D'EXPLICATION CONFIGURABLE PAR LE COMMERÇANT
// ==================================================================

test("texte marchand : UN emplacement de plus dans le catalogue FERMÉ existant, pas un CMS", () => {
  // v2.1 (RECOMPOSITION sur le main courant) -- l'assertion ne porte
  // plus sur un EFFECTIF (« 15 »), qui datait du jour où ce lot a été
  // écrit et qu'un lot légitime suivant (THEME & CONTENT SETTINGS v1)
  // a rendu faux, mais sur la PROPRIÉTÉ : ce lot possède exactement un
  // emplacement, il l'ajoute, et il ne retire ni ne renomme ceux des
  // autres.
  const BILLING_OWNED = ["billing_profile_explanation"] as const;
  for (const key of BILLING_OWNED) {
    assert.ok(COMMUNICATION_TEXT_KEYS.includes(key), `${key} doit être au catalogue`);
    assert.ok(PUBLIC_COMMUNICATION_TEXT_KEYS.includes(key), `${key} doit être public`);
  }
  // Ce lot n'est propriétaire QUE de cet emplacement : les trois
  // emplacements de THEME & CONTENT SETTINGS v1 doivent survivre à son
  // application (le SQL de ce lot réécrit la liste complète).
  for (const themeKey of ["order_help_button_label", "order_help_title", "order_help_body"] as const) {
    assert.ok(COMMUNICATION_TEXT_KEYS.includes(themeKey), `${themeKey} (Theme) a disparu`);
  }
  // Catalogue SQL = miroir exact du catalogue TypeScript, dans l'ordre.
  const code = flat(executable(SQL));
  for (const key of COMMUNICATION_TEXT_KEYS) {
    assert.ok(code.includes(`'${key}'`), `l'emplacement ${key} doit figurer dans le catalogue SQL`);
  }
  // Les gardes SQL portent elles aussi sur le CONTENU (égalité de
  // tableau), plus sur un effectif : une liste réécrite ne peut donc
  // pas effacer en silence l'emplacement d'un autre lot.
  assert.match(code, /if public\.communication_text_keys\(\) <> array\[/);
  assert.match(code, /if public\.public_communication_text_keys\(\) <> array\[/);
  assert.ok(
    !/cardinality\(public\.communication_text_keys\(\)\)\) <> \d+/.test(code),
    "aucune garde ne doit plus reposer sur un effectif figé du catalogue"
  );
});

test("texte marchand : AUCUN défaut plateforme -- non renseigné = rien affiché", () => {
  assert.equal(COMMUNICATION_TEXT_SPEC.billing_profile_explanation.defaultI18nKey, null);
  const resolved = resolveCommunicationText("billing_profile_explanation", null, (k) => k);
  assert.equal(resolved.source, "absent");
  assert.equal(resolved.text, null);
});

test("texte marchand : une surcharge du commerçant est rendue telle quelle", () => {
  const resolved = resolveCommunicationText(
    "billing_profile_explanation",
    { billing_profile_explanation: "Pour une facture au nom de votre société, indiquez sa raison sociale." },
    (k) => k
  );
  assert.equal(resolved.source, "merchant_override");
  assert.equal(resolved.text, "Pour une facture au nom de votre société, indiquez sa raison sociale.");
});

test("texte marchand : aucun libellé propre à un commerçant n'est codé en dur", () => {
  // On vise le CODE et les LIBELLÉS, pas les commentaires : le
  // mandat lui-même nomme « Au Lait Cru » pour l'interdire, et ce
  // rappel est cité dans les en-têtes -- une citation d'interdiction
  // n'est pas un texte marchand codé en dur.
  const stripComments = (source: string) =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith("--") &&
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("*") &&
          !trimmed.startsWith("/*")
        );
      })
      .join("\n");
  const touched = [
    read("lib", "communications", "text-keys.ts"),
    read("components", "InvoiceRequestFields.tsx"),
    read("lib", "invoice-request.ts"),
    SQL,
  ]
    .map(stripComments)
    .join("\n");
  for (const forbidden of ["Au Lait Cru", "au lait cru", "AU LAIT CRU", "Sanaa"]) {
    assert.ok(!touched.includes(forbidden), `nom de commerçant codé en dur : ${forbidden}`);
  }
  // Le libellé par défaut de l'emplacement est une clé i18n
  // PLATEFORME, identique pour tous les tenants -- jamais une phrase
  // propre à un commerçant.
  assert.equal(COMMUNICATION_TEXT_SPEC.billing_profile_explanation.defaultI18nKey, null);
  // Le back-office expose l'emplacement par son libellé i18n plateforme.
  assert.equal(
    translate("fr", "stCommKey_billing_profile_explanation"),
    "Explication des informations de facturation (checkout)"
  );
});

// ==================================================================
// 9. LIBELLÉS : L'OPTIONALITÉ EST VISIBLE
// ==================================================================

test("libellés (UX LOT 2026-10) : le champ dit « SIRET » sans mention « optionnel » ; la TVA reste annoncée optionnelle", () => {
  for (const [lang, marker] of [["fr", "optionnel"], ["en", "optional"], ["ar", "اختياري"]] as const) {
    assert.ok(translate(lang, "invSiren").includes("SIRET"), `invSiren doit dire SIRET en ${lang}`);
    assert.ok(!translate(lang, "invSiren").includes("SIREN"), `invSiren ne doit plus dire SIREN en ${lang}`);
    assert.ok(
      !translate(lang, "invSiren").toLowerCase().includes(marker.toLowerCase()),
      `invSiren ne doit plus dire « optionnel » en ${lang}`
    );
    assert.ok(
      translate(lang, "invVatNumber").toLowerCase().includes(marker.toLowerCase()),
      `invVatNumber doit dire « optionnel » en ${lang}`
    );
    assert.ok(translate(lang, "dsInvoiceSiren").includes("SIRET"), `dsInvoiceSiren (back-office) doit dire SIRET en ${lang}`);
    assert.ok(translate(lang, "invoiceSiretRequired").includes("SIRET"), `invoiceSiretRequired en ${lang}`);
  }
  // …et la ligne d'aide dit que le SIRET est obligatoire, la TVA facultative.
  assert.match(translate("fr", "invCompanyIdentifiersOptionalHint"), /SIRET est obligatoire/);
  assert.match(translate("fr", "invCompanyIdentifiersOptionalHint"), /TVA est facultatif/);
  assert.match(translate("en", "invCompanyIdentifiersOptionalHint"), /SIRET is required/);
});

test("libellés : prénom et nom de facturation existent dans les trois langues", () => {
  for (const lang of ["fr", "en", "ar"] as const) {
    for (const key of ["invFirstName", "invLastName", "invSiren", "dsInvoiceSiren", "invoiceSirenTooLong", "invoiceSiretRequired"]) {
      const value = translate(lang, key);
      assert.ok(value && value !== key, `clé ${key} manquante en ${lang}`);
    }
  }
});

// ==================================================================
// 10. ROLLBACK
// ==================================================================

test("rollback : restaure les deux RPC, les catalogues, et retire la colonne EN DERNIER", () => {
  const code = flat(executable(SQL_ROLLBACK));
  assert.match(code, /drop function public\.set_order_invoice_request\(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text\);/);
  assert.match(code, /create function public\.set_order_invoice_request\( p_order_id uuid, p_public_token uuid, p_invoice_type text, p_address_line_1 text, p_city text, p_postal_code text, p_country text, p_address_line_2 text default null, p_company_legal_name text default null, p_vat_number text default null, p_contact_name text default null, p_contact_email text default null \)/);
  assert.match(code, /alter table public\.order_invoice_request drop column siren;/);
  // L'ordre compte : les RPC ne doivent plus référencer la colonne au
  // moment où elle disparaît.
  assert.ok(
    code.indexOf("drop column siren") > code.indexOf("create function public.get_order_invoice_request"),
    "la colonne est retirée après la restauration des RPC"
  );
});

test("rollback : refuse de détruire des données saisies par des clients", () => {
  const code = flat(SQL_ROLLBACK);
  assert.match(code, /SCANYM_ROLLBACK_BLOCKED: % demande\(s\) de facture portent un SIREN saisi par le client/);
  assert.match(code, /SCANYM_ROLLBACK_BLOCKED: au moins un commerçant a configuré le texte billing_profile_explanation/);
  assert.match(code, /SCANYM_ROLLBACK_DRIFT_GUARD/);
});

test("pré-vol : prérequis réels, anti-double-application, et aucune supposition", () => {
  const code = flat(executable(SQL));
  assert.match(code, /SCANYM_SCHEMA_DRIFT: public\.order_invoice_request absente/);
  assert.match(code, /SCANYM_SCHEMA_DRIFT: set_order_invoice_request \(forme 12 arguments\) introuvable/);
  assert.match(code, /SCANYM_ALREADY_APPLIED: order_invoice_request\.siren existe déjà/);
  assert.match(code, /SCANYM_ALREADY_APPLIED: l''emplacement billing_profile_explanation existe déjà/);
  assert.match(code, /SCANYM_UNEXPECTED_STATE: une colonne SIRET existe/);
  // Postchecks : une seule surcharge de chaque RPC.
  assert.match(code, /SCANYM_POSTCHECK_FAILED: set_order_invoice_request existe en plusieurs surcharges/);
});

// ==================================================================
// 11. PÉRIMÈTRE — rien d'autre n'a bougé
// ==================================================================

test("périmètre : ni paiement, ni livraison, ni CGV, ni numérotation de facture", () => {
  const code = executable(SQL);
  for (const forbidden of [
    "monetico",
    "payment_status",
    "stuart",
    "delivery_fee",
    "cgv_template",
    "merchant_cgv",
    "invoice_number",
    "notification_outbox",
  ]) {
    assert.ok(!new RegExp(forbidden, "i").test(code), `le SQL du lot ne doit pas toucher ${forbidden}`);
  }
});

// ==================================================================
// 12. CBP-01 (HIGH) — LE NOM DE CONTACT DE FACTURATION EST TYPÉ
//
// Correction d'audit. La composition lisait prénom/nom SANS regarder
// le type de facture : un prénom/nom saisi en PARTICULIER, puis resté
// dans l'état du formulaire après une bascule en SOCIÉTÉ, écrasait le
// contact société réellement saisi et VISIBLE.
//
// Les cas A à E ci-dessous sont EXACTEMENT ceux demandés par le
// mandat de remédiation, avec ses propres valeurs.
// ==================================================================

/** État de formulaire après la séquence décrite : les champs de
 *  l'autre mode ne sont PAS nettoyés -- ils sont seulement démontés.
 *  C'est précisément ce que la composition doit ignorer. */
function afterSwitch(over: Partial<InvoiceRequestInfo>): InvoiceRequestInfo {
  return {
    ...EMPTY_INVOICE_REQUEST,
    wantsInvoice: true,
    addressLine1: "1 rue de la Facture",
    city: "Paris",
    postalCode: "75001",
    country: "FR",
    ...over,
  };
}

const ORDER_CUSTOMER = { firstName: "Zoe", lastName: "Commande" };

test("[CBP-01-A] PARTICULIER Alice Martin -> envoyé comme particulier => « Alice Martin »", () => {
  const info = afterSwitch({ invoiceType: "individual", firstName: "Alice", lastName: "Martin" });
  assert.equal(composeBillingContactName(info, ORDER_CUSTOMER), "Alice Martin");
});

test("[CBP-01-B] PARTICULIER Alice Martin -> bascule SOCIÉTÉ, contact visible Bob Durand => « Bob Durand »", () => {
  // L'état caché du mode particulier SUBSISTE : c'est le cas réel.
  const info = afterSwitch({
    invoiceType: "company",
    companyLegalName: "ACME SARL",
    firstName: "Alice",
    lastName: "Martin",
    contactName: "Bob Durand",
  });
  assert.equal(composeBillingContactName(info, ORDER_CUSTOMER), "Bob Durand");
  // Et la correction ne vient PAS d'un nettoyage d'état : les champs
  // cachés sont toujours là, la composition les ignore.
  assert.equal(info.firstName, "Alice");
  assert.equal(info.lastName, "Martin");
});

test("[CBP-01-C] SOCIÉTÉ Bob Durand -> bascule PARTICULIER, saisie explicite Carol Dupont => « Carol Dupont »", () => {
  const info = afterSwitch({
    invoiceType: "individual",
    companyLegalName: "ACME SARL",
    contactName: "Bob Durand",
    firstName: "Carol",
    lastName: "Dupont",
  });
  assert.equal(composeBillingContactName(info, ORDER_CUSTOMER), "Carol Dupont");
});

test("[CBP-01-D] bascules RÉPÉTÉES : le mode courant seul décide, jamais l'état de l'autre mode", () => {
  const hidden = { firstName: "Alice", lastName: "Martin", contactName: "Bob Durand" };
  // société -> particulier -> société -> particulier, sans jamais
  // nettoyer : à chaque instant, seul le mode courant est lu.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      composeBillingContactName(afterSwitch({ invoiceType: "company", companyLegalName: "ACME SARL", ...hidden }), ORDER_CUSTOMER),
      "Bob Durand",
      `itération ${i} (société)`
    );
    assert.equal(
      composeBillingContactName(afterSwitch({ invoiceType: "individual", ...hidden }), ORDER_CUSTOMER),
      "Alice Martin",
      `itération ${i} (particulier)`
    );
  }
});

test("[CBP-01-D bis] SOCIÉTÉ sans contact saisi : AUCUN repli -- ni l'état particulier, ni le nom de la commande", () => {
  const info = afterSwitch({
    invoiceType: "company",
    companyLegalName: "ACME SARL",
    firstName: "Alice",
    lastName: "Martin",
    contactName: "",
  });
  // Comportement d'AVANT ce lot pour une facture société : champ
  // optionnel laissé vide -> rien n'est transmis.
  assert.equal(composeBillingContactName(info, ORDER_CUSTOMER), "");
  assert.equal(normalizeOptional(composeBillingContactName(info, ORDER_CUSTOMER)), undefined);
});

test("[CBP-01-E] le nom FINAL (repli compris) est validé contre la limite de stockage de 45 caractères", () => {
  const long = "Maximilien-Alexandre".repeat(3); // 60 caractères
  // a) particulier, prénom + nom explicites : la COMPOSITION dépasse
  //    alors que chaque champ pris isolément tient dans 45.
  const composedTooLong = afterSwitch({
    invoiceType: "individual",
    firstName: "Maximilien-Alexandre-Benoit",
    lastName: "De-La-Tour-Du-Pin-Chambly",
  });
  assert.ok(composeBillingContactName(composedTooLong).length > INVOICE_FIELD_MAX_LENGTHS.contactName);
  assert.equal(getInvoiceRequestErrors(composedTooLong).contactName, "invoiceContactNameTooLong");

  // b) le REPLI aussi est validé : champs de facturation vides, mais
  //    un prénom/nom de commande trop long -> détecté AVANT l'appel
  //    réseau, plus seulement par le refus de la RPC.
  const fallbackTooLong = afterSwitch({ invoiceType: "individual" });
  assert.deepEqual(getInvoiceRequestErrors(fallbackTooLong), {}, "sans repli, rien à signaler");
  assert.equal(
    getInvoiceRequestErrors(fallbackTooLong, { firstName: long, lastName: long }).contactName,
    "invoiceContactNameTooLong"
  );

  // c) société : la limite porte sur le champ société, et le repli
  //    n'intervient jamais.
  // UX LOT 2026-10 : SIRET fourni (requis pour une société) pour que
  // seule la règle testée ici (nom de contact) soit en jeu.
  const companyLong = afterSwitch({
    invoiceType: "company",
    companyLegalName: "ACME SARL",
    siren: "12345678900012",
    contactName: long,
  });
  assert.equal(getInvoiceRequestErrors(companyLong).contactName, "invoiceContactNameTooLong");
  const companyShort = afterSwitch({
    invoiceType: "company",
    companyLegalName: "ACME SARL",
    siren: "12345678900012",
    contactName: "Bob Durand",
  });
  assert.deepEqual(
    getInvoiceRequestErrors(companyShort, { firstName: long, lastName: long }),
    {},
    "le repli ne s'applique pas à une facture société, il ne peut donc pas la faire échouer"
  );
});

test("[CBP-01] la correction vit dans la COMPOSITION, pas dans un nettoyage d'état", () => {
  const lib = read("lib", "invoice-request.ts");
  const fn = lib.slice(
    lib.indexOf("export function composeBillingContactName"),
    lib.indexOf("export function deriveInvoiceAddressFromCustomer")
  );
  // La fonction décide explicitement selon le type…
  assert.match(fn, /if \(info\.invoiceType === "company"\)/);
  // …et le mode société ne lit NI prénom, NI nom, NI repli.
  const companyBranch = fn.slice(fn.indexOf('if (info.invoiceType === "company")'), fn.indexOf("const own ="));
  assert.ok(!/firstName|lastName|fallback/.test(companyBranch), "la branche société ne lit aucun champ de l'autre mode");
  // Et aucun composant ne remet à zéro les champs de l'autre mode au
  // changement de type : la correctness ne dépend pas d'un nettoyage.
  const ui = read("components", "InvoiceRequestFields.tsx");
  assert.ok(
    !/set\("firstName", ""\)|set\("contactName", ""\)|firstName: "", lastName: ""/.test(ui),
    "aucun nettoyage d'état utilisé comme mécanisme de correction"
  );
});

// ==================================================================
// 13. CBP-02 (HIGH) — LE ROLLBACK EST TRANSACTIONNELLEMENT SÛR
//
// Correction d'audit. Les gardes destructives vivaient AVANT `begin;` :
// deux défauts en découlaient.
//
//   (a) TOCTOU : entre le constat « aucun SIREN » et le `drop column`,
//       une écriture concurrente pouvait valider un SIREN, détruit
//       ensuite sans que personne ne l'ait décidé.
//   (b) Continuation : un exécuteur SANS `ON_ERROR_STOP` poursuit
//       après l'erreur de la garde ; la destruction suivait malgré le
//       refus.
//
// Ces tests verrouillent la STRUCTURE. La PREUVE DE COMPORTEMENT est
// faite sur une vraie base PostgreSQL par
// `supabase/tests/customer-billing-profile-v2-rollback-safety-check.sh`
// (ROLLBACK-SAFETY-01..04), dont l'existence et la couverture sont
// elles aussi vérifiées ici.
// ==================================================================

/** Lignes SQL EXÉCUTABLES, dans l'ordre, commentaires et vide retirés. */
const rollbackStatements = () =>
  SQL_ROLLBACK.split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("--"));

/** Idem, mais SANS l'intérieur des corps `$$ … $$` : un `end;` dans le
 *  corps d'une fonction restaurée n'est pas une fin de transaction, et
 *  le confondre avec une ferait échouer un test pour la mauvaise
 *  raison. Seules les instructions de PREMIER NIVEAU décident de la
 *  portée transactionnelle du fichier. */
const topLevelRollbackStatements = () => {
  const kept: string[] = [];
  let inside = false;
  for (const line of rollbackStatements()) {
    if (!inside) kept.push(line);
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inside = !inside;
  }
  assert.equal(inside, false, "corps `$$` non refermé dans le fichier de rollback");
  return kept;
};

test("[CBP-02] `begin;` est la PREMIÈRE instruction exécutable du fichier", () => {
  assert.equal(rollbackStatements()[0], "begin;");
});

test("[CBP-02] les verrous sont pris AVANT toute garde, et AVANT toute lecture de données", () => {
  const lines = rollbackStatements();
  const lockLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^lock table /.test(line));
  assert.equal(lockLines.length, 2, "les deux tables du lot sont verrouillées");

  const firstGuard = lines.findIndex((line) => line.startsWith("do $$"));
  assert.ok(firstGuard > 0, "le fichier comporte une garde");
  for (const { line, index } of lockLines) {
    assert.ok(index < firstGuard, `verrou pris trop tard : ${line}`);
  }

  // Le niveau doit CONFLITER avec ROW EXCLUSIVE (ce que prend tout
  // INSERT/UPDATE/DELETE). SHARE est le plus faible qui le fasse ;
  // ACCESS SHARE et ROW SHARE laisseraient passer l'écrivain.
  for (const { line } of lockLines) {
    assert.match(line, /in share mode;$/, "un niveau ornemental laisserait écrire pendant la fenêtre");
    assert.ok(
      !/in (access share|row share|access exclusive|exclusive) mode/.test(line),
      `niveau de verrou inattendu : ${line}`
    );
  }
});

test("[CBP-02] toute garde destructive vit DANS la transaction, avant toute DDL", () => {
  const lines = rollbackStatements();
  const begin = lines.indexOf("begin;");
  // La DDL qui compte est celle de PREMIER NIVEAU : un `create temp
  // table` à l'intérieur d'un corps `$$ … $$` (la prise de notes de
  // l'état hors périmètre) n'est pas une instruction destructive du
  // fichier, et le confondre avec une ferait échouer ce test pour la
  // mauvaise raison.
  const topLevel = new Set(topLevelRollbackStatements());
  const firstDdl = lines.findIndex(
    (line) => topLevel.has(line) && /^(drop|alter|create) /i.test(line)
  );
  const guards = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /SCANYM_(ROLLBACK_BLOCKED|NOTHING_TO_ROLL_BACK|ROLLBACK_DRIFT_GUARD|SCHEMA_DRIFT)/.test(line));
  assert.ok(guards.length >= 4, "les gardes du fichier sont toujours là");
  for (const { line, index } of guards) {
    assert.ok(index > begin, `garde hors transaction : ${line}`);
    assert.ok(index < firstDdl, `garde postérieure à une DDL destructive : ${line}`);
  }
});

test("[CBP-02] `commit;` est la DERNIÈRE instruction, et il n'existe aucune seconde transaction", () => {
  const lines = topLevelRollbackStatements();
  assert.equal(lines[lines.length - 1], "commit;");
  assert.equal(lines.filter((line) => line === "begin;").length, 1, "une seule transaction");
  assert.equal(lines.filter((line) => line === "commit;").length, 1, "un seul commit");
  // Aucun `rollback;`/`commit;` intermédiaire ne doit refermer la
  // transaction avant la fin : la destruction resterait joignable par
  // une transaction indépendante après une garde en échec.
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1) break;
    assert.ok(!/^(commit|rollback|end);$/.test(line), `transaction refermée trop tôt en ligne logique ${index}`);
  }
});

test("[CBP-02] la sûreté ne dépend d'AUCUN réglage d'exécuteur", () => {
  const code = SQL_ROLLBACK;
  // Pas de `\set ON_ERROR_STOP`, pas de méta-commande psql : le fichier
  // doit être sûr même joué par un exécuteur qui poursuit après erreur.
  assert.ok(!/^\s*\\/m.test(code), "aucune méta-commande d'exécuteur dans le fichier");
  assert.ok(!/ON_ERROR_STOP/.test(code.replace(/^--.*$/gm, "")), "aucune dépendance exécutable à ON_ERROR_STOP");
});

test("[CBP-02] le banc d'essai PostgreSQL couvre les quatre scénarios exigés", () => {
  const script = read("supabase", "tests", "customer-billing-profile-v2-rollback-safety-check.sh");
  for (const scenario of [
    "ROLLBACK-SAFETY-01",
    "ROLLBACK-SAFETY-02",
    "ROLLBACK-SAFETY-03",
    "ROLLBACK-SAFETY-04",
  ]) {
    assert.ok(script.includes(scenario), `scénario ${scenario} absent du banc d'essai`);
  }
  // -02 doit jouer le fichier SANS ON_ERROR_STOP.
  assert.match(script, /psql -X -q -d "\$\{DB\}" -f "\$\{REPO_ROOT\}\/supabase\/DRAFT-lot-customer-billing-profile-v2-rollback\.sql"/);
  // -03 doit rejouer LES VERROUS DU FICHIER, jamais un niveau réécrit
  // dans le test : sinon un verrou ornemental passerait inaperçu.
  assert.match(script, /LOCKS="\$\(grep -E '\^lock table \.\*;\$'/);
  assert.match(script, /printf '%s\\n' "\$\{LOCKS\}" >&3/);
  // …et l'instrument lui-même est contrôlé : sans verrou, l'écrivain
  // concurrent DOIT aboutir.
  assert.ok(script.includes("instrument valide"), "contre-épreuve de l'instrument absente");
});

test("[CBP-02] les protections anti-dérive antérieures sont PRÉSERVÉES", () => {
  const code = flat(SQL_ROLLBACK);
  assert.match(code, /SCANYM_NOTHING_TO_ROLL_BACK: order_invoice_request\.siren est déjà absente/);
  assert.match(code, /SCANYM_ROLLBACK_BLOCKED: % demande\(s\) de facture portent un SIREN saisi par le client/);
  assert.match(code, /SCANYM_ROLLBACK_BLOCKED: au moins un commerçant a configuré le texte billing_profile_explanation/);
  assert.match(code, /SCANYM_ROLLBACK_DRIFT_GUARD/);
  assert.match(code, /SCANYM_ROLLBACK_CHECK_FAILED/);
});
