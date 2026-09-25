import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { renderCgv } = await import("../lib/legal/render.ts");
import type { CgvTemplateControlledSections } from "../lib/legal/render.ts";

// ====================================================================
// Scanym — ONLINE WITHDRAWAL / RETRACTATION FOUNDATION v1 (Claude Monet)
//
// Contrats NON NÉGOCIABLES de ce lot :
//   - l'éligibilité d'une ligne vient d'un INSTANTANÉ immuable, jamais
//     du catalogue courant, jamais du client ;
//   - une ligne historique (NULL) n'est JAMAIS supposée éligible ;
//   - la rétractation n'est pas un statut de commande ;
//   - l'attribut marchand ne fuit sur aucun chemin client ;
//   - l'accusé de réception n'est jamais annoncé comme envoyé tant
//     qu'aucun canal réel ne l'a envoyé.
//
// Les comportements SQL sont en outre exécutés pour de vrai sur
// PostgreSQL 16 (voir le rapport de lot, section PREUVES SQL) ; les
// tests ci-dessous verrouillent le CONTRAT écrit, qui est ce que
// l'auditeur relit.
// ====================================================================

const repoRoot = process.cwd();
const sql = (file: string) => readFileSync(path.join(repoRoot, "supabase", file), "utf8");
const MIGRATION = sql("DRAFT-lot-online-withdrawal-foundation-v1.sql");
const ROLLBACK = sql("DRAFT-lot-online-withdrawal-foundation-v1-ROLLBACK.sql");
const CGV_V6 = sql("DRAFT-lot-online-withdrawal-cgv-template-v6.sql");
const flat = (value: string) => value.replace(/\s+/g, " ");

/**
 * SQL RÉELLEMENT EXÉCUTÉ : commentaires `--` et littéraux entre
 * apostrophes retirés. Indispensable pour les assertions de PÉRIMÈTRE :
 * le lot DOCUMENTE en toutes lettres qu'il ne touche ni
 * `orders.status`, ni `payment_status`, et qu'il ne gère aucun
 * remboursement (en-tête du fichier + `comment on table`). Chercher ces
 * mots dans le texte brut ferait échouer le test PRÉCISÉMENT parce que
 * la garantie est écrite -- ce qu'il faut interdire, ce sont les
 * INSTRUCTIONS, pas les phrases qui promettent leur absence.
 */
const executable = (value: string) => {
  // Un simple enchaînement de `replace` ne suffit PAS : les
  // commentaires contiennent des apostrophes françaises (« l'historique »)
  // et les littéraux contiennent des tirets doubles (« -- aucun rôle
  // client »), donc chaque passe casserait l'appariement de l'autre.
  // On lit donc le fichier caractère par caractère, un seul passage.
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] === "-" && value[i + 1] === "-") {
      while (i < value.length && value[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (value[i] === "'") {
      i += 1;
      while (i < value.length) {
        if (value[i] === "'") {
          if (value[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " '' ";
      continue;
    }
    out += value[i];
    i += 1;
  }
  return out;
};

// --------------------------------------------------------------
// A. Attribut produit : défaut Non, interne
// --------------------------------------------------------------
test("A — l'attribut produit existe, vaut Non par défaut et n'est jamais déduit", () => {
  assert.match(
    flat(MIGRATION),
    /alter table public\.menu_items add column withdrawal_eligible boolean not null default false/,
    "colonne NOT NULL DEFAULT false"
  );
  // Aucune inférence : le lot ne lit ni catégorie, ni DLC/DDM, ni
  // régime marchand pour décider de l'éligibilité d'un produit.
  const decisionSources = /withdrawal_eligible\s*(=|:=)\s*(case|coalesce)?[^;]*\b(category|dlc|ddm|expiry|shelf|withdrawal_regime)\b/i;
  assert.ok(!decisionSources.test(MIGRATION), "aucune éligibilité déduite d'une autre donnée");
});

// --------------------------------------------------------------
// G/H. Instantané immuable + historique NULL
// --------------------------------------------------------------
test("G — l'instantané de ligne est pris À L'INSERTION, une seule fois, jamais recalculé", () => {
  assert.match(
    flat(MIGRATION),
    /alter table public\.order_items add column withdrawal_eligible_at_order_time boolean;/,
    "colonne d'instantané nullable (l'historique doit pouvoir rester NULL)"
  );
  assert.match(
    flat(MIGRATION),
    /create trigger trg_order_items_snapshot_withdrawal_eligibility before insert on public\.order_items/,
    "déclencheur BEFORE INSERT"
  );
  assert.ok(
    !/create trigger[^;]*(before|after)\s+update[^;]*order_items[^;]*withdrawal/i.test(MIGRATION),
    "aucun déclencheur sur UPDATE : un instantané pris est définitif"
  );
  // La copie ne se fait que si la valeur n'est pas déjà posée.
  assert.match(
    flat(MIGRATION),
    /if new\.withdrawal_eligible_at_order_time is null and new\.menu_item_id is not null then/,
    "copie une seule fois"
  );
});

test("H — une ligne historique (NULL) n'est jamais traitée comme éligible", () => {
  // Lecture : `is true` (et non `is not false`) dans la RPC d'options.
  assert.match(
    flat(MIGRATION),
    /and oi\.withdrawal_eligible_at_order_time is true/,
    "seules les lignes explicitement true sont proposées"
  );
  // Écriture : refus explicite.
  assert.match(
    flat(MIGRATION),
    /if v_line\.withdrawal_eligible_at_order_time is not true then raise exception using errcode = '42501', message = 'WITHDRAWAL_LINE_NOT_ELIGIBLE'/,
    "une ligne non explicitement éligible est refusée à l'écriture"
  );
  assert.ok(
    !/coalesce\(\s*\w*\.?withdrawal_eligible_at_order_time\s*,\s*true\s*\)/i.test(MIGRATION),
    "jamais de coalesce(..., true) qui transformerait NULL en éligible"
  );
  assert.ok(
    !/update public\.order_items set withdrawal_eligible_at_order_time/i.test(MIGRATION),
    "aucun remplissage rétroactif des lignes historiques"
  );
});

// --------------------------------------------------------------
// O/P. Autorité client : capacité de suivi + isolation locataire
// --------------------------------------------------------------
test("O — les deux RPC client exigent la capacité LIÉE à la commande, jamais order_id seul", () => {
  for (const fn of [
    "get_withdrawal_options_by_capability(",
    "submit_withdrawal_request_by_capability(",
  ]) {
    assert.ok(MIGRATION.includes(fn), `${fn} doit exister`);
  }
  // Même prédicat de liaison que CUSTOMER TRACKING v3.1.
  const binding = /c\.id = p_capability_id and c\.order_id = p_order_id/;
  assert.ok(binding.test(flat(MIGRATION)), "liaison capability_id + order_id");
  assert.match(
    flat(MIGRATION),
    /c\.secret_hash = pg_catalog\.sha256\(pg_catalog\.convert_to\(p_secret, 'UTF8'\)\)/,
    "le secret est vérifié par empreinte, jamais stocké en clair"
  );
  // Aucune RPC de rétractation n'accepte un public_token ou un e-mail
  // comme preuve de possession.
  assert.ok(
    !/submit_withdrawal_request_by_capability[\s\S]{0,400}p_public_token/i.test(MIGRATION),
    "jamais d'authentification par public_token"
  );
});

test("P — isolation locataire : restaurant_id vient de la commande, jamais de l'appelant", () => {
  assert.match(
    flat(MIGRATION),
    /insert into public\.withdrawal_requests as wr \([^)]*restaurant_id/,
    "restaurant_id est écrit par le serveur"
  );
  assert.match(flat(MIGRATION), /values \( v_order\.restaurant_id, p_order_id,/, "il vient de la commande");
  // Aucun paramètre de restaurant n'existe dans la signature.
  assert.ok(
    !/submit_withdrawal_request_by_capability\([^)]*p_restaurant_id/.test(flat(MIGRATION)),
    "aucun restaurant_id fourni par l'appelant"
  );
  // Ligne d'une AUTRE commande : refusée.
  assert.match(
    flat(MIGRATION),
    /where oi\.id = v_order_item_id and oi\.order_id = p_order_id/,
    "une ligne d'une autre commande ne peut pas être visée"
  );
});

test("M — la quantité cumulée ne peut jamais dépasser la quantité commandée", () => {
  assert.match(flat(MIGRATION), /for update;/, "les lignes sont verrouillées pendant la vérification");
  assert.match(
    flat(MIGRATION),
    /if v_already \+ v_quantity > v_line\.quantity then raise exception using errcode = '22023', message = 'WITHDRAWAL_QUANTITY_EXCEEDS_ORDERED'/,
    "garde cumulative explicite"
  );
  // Le cumul additionne les demandes NON annulées, la demande courante exclue.
  assert.match(flat(MIGRATION), /and wr\.status = 'recorded' and wr\.id <> v_request_id/, "cumul correct");
});

test("rejeu — le même client_request_id retourne la demande existante, sans double décompte", () => {
  assert.match(flat(MIGRATION), /unique \(order_id, client_request_id\)/, "unicité en base");
  assert.match(
    flat(MIGRATION),
    /if found then return query select v_existing\.id, v_existing\.requested_at, v_existing\.acknowledgement_status, true; return; end if;/,
    "rejeu renvoyé tel quel"
  );
});

// --------------------------------------------------------------
// Statuts de commande et périmètre
// --------------------------------------------------------------
test("périmètre — aucun statut de commande, aucun payment_status, aucun remboursement", () => {
  const code = executable(MIGRATION);
  // Aucune INSTRUCTION ne réécrit le cycle de vie de la commande : la
  // rétractation est un évènement juridique parallèle.
  assert.ok(!/update\s+public\.orders\b/i.test(code), "orders n'est jamais mis à jour");
  assert.ok(!/payment_status/i.test(code), "payment_status jamais touché");
  assert.ok(!/\brefund\w*/i.test(code), "aucun remboursement dans ce lot");
  // Les statuts canoniques de commande ne sont ni redéfinis ni étendus :
  // la table `orders` n'est pas altérée du tout par ce lot. (Le `status`
  // de `withdrawal_requests` est un état PROPRE à la déclaration --
  // recorded/cancelled -- et n'a rien à voir avec le cycle de vie de la
  // commande ; on vise donc la table, pas le mot « status ».)
  assert.ok(!/alter\s+table\s+(?:only\s+)?public\.orders\b/i.test(code), "orders n'est pas altérée");
  assert.match(
    flat(executable(MIGRATION)),
    /create table public\.withdrawal_requests \(/,
    "la rétractation vit dans SA PROPRE table"
  );
  // …et la promesse correspondante est bien ÉCRITE pour l'auditeur.
  assert.match(flat(MIGRATION), /N''altère JAMAIS orders\.status ni payment_status/);
});

test("privilèges — les tables ne sont accessibles par aucun rôle client", () => {
  assert.match(
    flat(MIGRATION),
    /revoke all on table public\.withdrawal_requests from public, anon, authenticated;/,
    "aucun privilège direct"
  );
  assert.match(flat(MIGRATION), /alter table public\.withdrawal_requests enable row level security;/);
  assert.match(flat(MIGRATION), /alter table public\.withdrawal_request_items enable row level security;/);
  // Les helpers privés ne sont donnés à personne.
  assert.match(
    flat(MIGRATION),
    /revoke all on function public\._scanym_has_operational_durable_ack_channel\(\) from public;/
  );
});

// --------------------------------------------------------------
// S. Garde runtime du moteur CGV
// --------------------------------------------------------------
test("S — la garde CGV teste les PRIMITIVES réelles, jamais un `true` littéral", () => {
  // v1.1 -- la garde est scindée en DEUX questions : les primitives
  // existent-elles (fonction dédiée), et la fonctionnalité statutaire
  // est-elle complète (primitives ET canal d'accusé). Les primitives
  // restent VÉRIFIÉES objet par objet, jamais supposées.
  const primitivesFn = MIGRATION.slice(
    MIGRATION.indexOf("create function public._scanym_has_online_withdrawal_primitives()")
  );
  const primitivesBody = primitivesFn.slice(0, primitivesFn.indexOf("$$;") + 3);
  assert.ok(!/select\s+true\s*;/.test(primitivesBody), "jamais un true nu");
  for (const primitive of [
    "public.withdrawal_requests",
    "public.withdrawal_request_items",
    "submit_withdrawal_request_by_capability",
    "get_withdrawal_options_by_capability",
    "withdrawal_eligible_at_order_time",
  ]) {
    assert.ok(primitivesBody.includes(primitive), `la garde doit vérifier ${primitive}`);
  }
  const guard = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public._scanym_has_online_withdrawal_runtime()")
  );
  const body = guard.slice(0, guard.indexOf("$$;") + 3);
  assert.ok(!/select\s+true\s*;/.test(body), "jamais un true nu");
  assert.ok(
    body.includes("_scanym_has_online_withdrawal_primitives()") &&
      body.includes("_scanym_has_operational_durable_ack_channel()"),
    "la fonctionnalité n'est complète que si l'accusé de réception peut être envoyé"
  );
  // Et le rollback la remet à false : sans runtime, publication fermée.
  assert.match(flat(ROLLBACK), /create or replace function public\._scanym_has_online_withdrawal_runtime\(\) returns boolean language sql immutable as \$\$ select false; \$\$;/);
});

// --------------------------------------------------------------
// T. Accusé de réception — sémantique honnête
// --------------------------------------------------------------
test("T — l'accusé de réception n'est JAMAIS annoncé comme envoyé sans envoi réel", () => {
  // Le canal est testé, pas supposé.
  assert.match(
    flat(MIGRATION),
    /create function public\._scanym_has_operational_durable_ack_channel\(\)/,
    "un test de canal existe"
  );
  // L'écriture de la demande ne peut produire que 'pending' ou
  // 'unavailable_no_channel' -- jamais 'sent'.
  assert.match(
    flat(MIGRATION),
    /case when public\._scanym_has_operational_durable_ack_channel\(\) then 'pending' else 'unavailable_no_channel' end/,
    "statut honnête à l'enregistrement"
  );
  const submitBody = MIGRATION.slice(
    MIGRATION.indexOf("create function public.submit_withdrawal_request_by_capability"),
    MIGRATION.indexOf("comment on function public.submit_withdrawal_request_by_capability")
  );
  assert.ok(!/'sent'/.test(submitBody), "la RPC d'écriture n'écrit jamais 'sent'");
  // 'sent' impose un horodatage d'envoi.
  assert.match(
    flat(MIGRATION),
    /check \(\(acknowledgement_status = 'sent'\) = \(acknowledgement_sent_at is not null\)\)/,
    "'sent' sans horodatage est structurellement impossible"
  );
  // Et le contenu durable porte date et heure de la déclaration.
  assert.match(flat(MIGRATION), /'declared_at', v_requested_at/, "date et heure figées dans la déclaration");
  assert.match(flat(MIGRATION), /'lines', v_lines/, "contenu de la déclaration figé");
});

// --------------------------------------------------------------
// U. Non-divulgation publique
// --------------------------------------------------------------
test("U — l'attribut marchand ne fuit sur aucun chemin client", () => {
  const publicService = readFileSync(path.join(repoRoot, "lib", "services", "restaurant.ts"), "utf8");
  // La requête publique fait `menu_items(*)` : le retrait est donc fait
  // explicitement à la frontière, avant sérialisation vers le client.
  assert.match(
    publicService,
    /const \{ withdrawal_eligible: _internalWithdrawalEligible, \.\.\.publicItem \}/,
    "retrait explicite avant l'étalement public"
  );
  assert.ok(
    !/\.\.\.i,/.test(publicService.slice(publicService.indexOf("const { withdrawal_eligible"))),
    "l'objet brut n'est plus étalé après le retrait"
  );

  for (const file of [
    "components/MenuView.tsx",
    "lib/customer-product-tags.ts",
    "lib/customer-collections.ts",
    "lib/menu-i18n.ts",
  ]) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    assert.ok(
      !source.includes("withdrawal_eligible"),
      `${file} ne doit jamais mentionner l'attribut interne`
    );
  }

  // Et la RPC publique de carte n'expose pas la colonne : la lecture
  // marchande get_merchant_catalogue est la seule à la retourner.
  assert.match(
    flat(MIGRATION),
    /revoke all on function public\.get_merchant_catalogue\(uuid, boolean\) from public, anon;/,
    "le catalogue marchand reste interdit à anon"
  );
});

// --------------------------------------------------------------
// Q/R. CGV : commandes mixtes, immuabilité des versions publiées
// --------------------------------------------------------------
test("Q — la version 6 du gabarit porte la règle des commandes mixtes, citant L221-28", () => {
  assert.match(CGV_V6, /"mixed_order_withdrawal_clause": "Lorsque la commande comporte à la fois des produits bénéficiant du droit de rétractation/);
  assert.match(CGV_V6, /L221-28/);
  assert.match(CGV_V6, /4° de cet article/);
  // La version 6 ne nie plus l'existence de la fonctionnalité en ligne.
  assert.ok(
    !/"withdrawal_exercise_method_clause": "[^"]*n'est pas encore propos/.test(CGV_V6),
    "la clause d'exercice doit décrire la fonctionnalité réellement livrée"
  );
  assert.match(CGV_V6, /Exercer mon droit de rétractation/, "l'intitulé exact du point d'entrée est cité");
});

test("R — aucune version de CGV déjà publiée n'est modifiée", () => {
  // Seul is_default bascule ; aucun UPDATE de controlled_sections.
  assert.ok(
    !/update public\.cgv_template\s+set\s+controlled_sections/i.test(CGV_V6),
    "le contenu d'une version existante n'est jamais réécrit"
  );
  assert.ok(
    !/update public\.merchant_cgv_version/i.test(CGV_V6),
    "aucune CGV marchande publiée n'est touchée"
  );
  assert.ok(!/delete from public\.cgv_template/i.test(CGV_V6), "aucune version supprimée");
  assert.match(
    flat(CGV_V6),
    /update public\.cgv_template set is_default = false where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 5;/,
    "bascule explicite de is_default"
  );
  assert.match(
    flat(CGV_V6),
    /where template_code = 'FR_FOOD_PERISHABLE_B2C' and version = 5 and status = 'PUBLISHED'/,
    "la version 5 est vérifiée intacte après insertion"
  );
  // v1.1 -- le gabarit v6 n'est insérable au CATALOGUE que si le
  // MÉCANISME décrit existe réellement (primitives). L'autorisation de
  // PUBLIER ce texte au nom d'un marchand est une autre question, que
  // tranche la garde de publication (voir la suite v1.1).
  assert.match(
    flat(CGV_V6),
    /if not public\._scanym_has_online_withdrawal_primitives\(\) then raise exception 'SCANYM_WITHDRAWAL_PRIMITIVES_MISSING/,
    "on n'inscrit pas au catalogue un texte décrivant un mécanisme absent"
  );
});

// --------------------------------------------------------------
// Rendu des nouvelles clauses
// --------------------------------------------------------------
const BASE_TEMPLATE: CgvTemplateControlledSections = {
  header: "Conditions Générales de Vente",
  identity_intro: "Intro.",
  withdrawal_clauses: {
    EXEMPT_PERISHABLE: "Clause denrées périssables.",
    STANDARD_14_DAYS: "Clause quatorze jours.",
    MIXED: null,
  },
  mediator_clause: "Médiateur :",
  preparation_clause: "Préparation.",
  cancellation_clause_label: "Annulation",
  substitution_clause_label: "Substitution",
  jurisdiction_clause: "Juridiction.",
};

const render = (template: CgvTemplateControlledSections, regime: "STANDARD_14_DAYS" | "EXEMPT_PERISHABLE") =>
  renderCgv({
    sellerName: "Au lait cru",
    template,
    legal: {
      legalForm: "SARL",
      addressLine1: "12 rue du Fromage",
      addressLine2: null,
      postalCode: "75001",
      city: "Paris",
      governingCountry: "France",
      customerServiceEmail: "contact@example.org",
      customerServicePhone: null,
      mediatorName: "CM2C",
      mediatorAddress: "49 rue de Ponthieu",
      mediatorWebsite: "https://www.cm2c.net",
    },
    business: {
      withdrawalRegime: regime,
      preparationTimeMin: 30,
      preparationTimeMax: 60,
      preparationTimeUnit: "MINUTES",
      cancellationPolicyText: null,
      substitutionPolicyText: null,
    },
    locale: "fr",
    presentationVariant: "FORMAL",
  });

test("rendu — les clauses de rétractation en ligne ne sortent que pour un régime à droit réel", () => {
  const template: CgvTemplateControlledSections = {
    ...BASE_TEMPLATE,
    mixed_order_withdrawal_clause: "Règle des commandes mixtes.",
    withdrawal_return_and_refund_clause: "Renvoi et remboursement.",
    withdrawal_acknowledgement_clause: "Accusé de réception.",
  };

  const standard = render(template, "STANDARD_14_DAYS");
  for (const clause of [
    "Règle des commandes mixtes.",
    "Renvoi et remboursement.",
    "Accusé de réception.",
  ]) {
    assert.ok(standard.includes(clause), `« ${clause} » doit être rendue pour STANDARD_14_DAYS`);
  }

  const exempt = render(template, "EXEMPT_PERISHABLE");
  for (const clause of [
    "Règle des commandes mixtes.",
    "Renvoi et remboursement.",
    "Accusé de réception.",
  ]) {
    assert.ok(!exempt.includes(clause), "aucune clause de rétractation pour un régime sans droit de rétractation");
  }

  // Gabarit sans ces clés (v1..v5) : section inchangée, jamais d'erreur.
  const legacy = render(BASE_TEMPLATE, "STANDARD_14_DAYS");
  assert.ok(legacy.includes("Clause quatorze jours."));
  assert.ok(!legacy.includes("Règle des commandes mixtes."));
});
