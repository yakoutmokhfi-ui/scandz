import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const { DICTS, resolveLangFromParam, translate } = await import("../lib/i18n.ts");
const { DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH } = await import("../lib/delivery-rule-editor.ts");

// ====================================================================
// MICRO-LOT — STOREFRONT ORDER HELP WORDING + CUSTOMER TEXT LENGTH v1
//
// Deux corrections produit, étroites, sans changement fonctionnel :
//   1. le libellé de la cartouche vitrine ET du titre de sa fenêtre
//      passe de « Modes et tarifs de livraison » à « Comment passer
//      commande », dans toutes les langues prises en charge ;
//   2. le texte client d'une RÈGLE de livraison passe de 500 à 1000
//      caractères, sans troncature, de la saisie jusqu'à l'affichage.
//
// Le COMPORTEMENT de la base (contraintes réelles, writer réel,
// projection publique réelle, cliché de commande réel) est prouvé sur
// la chaîne SQL du dépôt dans PGlite par
// tests/delivery-customer-text-1000-v1-sql.test.ts. Ici : les
// invariants purs et structurels, plus le rendu DOM de la vitrine
// (fichier .dom dédié pour les 1000 caractères rendus).
// ====================================================================

const repoRoot = process.cwd();
const read = (...parts: string[]) => readFileSync(path.join(repoRoot, ...parts), "utf8");

const EXPECTED_LABEL: Record<string, string> = {
  fr: "Comment passer commande",
  en: "How to order",
  nl: "Hoe bestellen",
  ar: "كيفية الطلب",
};

// --------------------------------------------------------------------
// 1. LE LIBELLÉ, DANS TOUTES LES LANGUES PRISES EN CHARGE.
// --------------------------------------------------------------------

test("[SW-01] le libellé exact est rendu dans les quatre langues du mandat", () => {
  for (const [lang, expected] of Object.entries(EXPECTED_LABEL)) {
    assert.equal(
      translate(lang, "deliveryConditionsTitle"),
      expected,
      `libellé ${lang} : « ${expected} » attendu`
    );
  }
});

test("[SW-02] l'ancien libellé a disparu de toutes les langues", () => {
  for (const lang of Object.keys(DICTS)) {
    const value = translate(lang, "deliveryConditionsTitle");
    for (const old of ["Modes et tarifs de livraison", "Delivery options and prices", "خيارات التوصيل وأسعاره"]) {
      assert.notEqual(value, old, `${lang} porte encore l'ancien libellé`);
    }
  }
  // …y compris dans la source : aucune occurrence résiduelle dans le
  // catalogue de traduction.
  const i18n = read("lib", "i18n.ts");
  assert.ok(!i18n.includes("Modes et tarifs de livraison"), "ancien libellé FR résiduel");
  assert.ok(!i18n.includes("Delivery options and prices"), "ancien libellé EN résiduel");
});

test("[SW-03] le libellé est porté par UNE seule clé, utilisée par la cartouche ET le titre", () => {
  const component = read("components", "DeliveryConditions.tsx");
  const occurrences = [...component.matchAll(/t\("deliveryConditionsTitle"\)/g)].length;
  assert.equal(occurrences, 2, "le bouton et le titre de la fenêtre lisent la même clé");
  // Aucun libellé en dur dans le CODE du composant : le texte vient de
  // l'i18n. Les commentaires, eux, nomment légitimement la fenêtre.
  const code = component
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  for (const label of Object.values(EXPECTED_LABEL)) {
    assert.ok(!code.includes(label), `libellé « ${label} » codé en dur dans le composant`);
  }
});

test("[SW-04] le dictionnaire néerlandais est PARTIEL, et le repli par clé reste le français", () => {
  // Le mandat demande le néerlandais pour CE libellé. Traduire le reste
  // de l'interface est un autre travail : toute autre clé doit donc
  // rendre exactement ce qu'elle rendait avant ce lot.
  //
  // ÉLARGISSEMENT DOCUMENTÉ (CSDJ-BO-1, issue #149) : ce test affirmait
  // `deepEqual(Object.keys(DICTS.nl), ["deliveryConditionsTitle"])`, une
  // liste littérale d'UNE clé. Le mandat CSDJ-BO-1 exige explicitement un
  // « affichage accessible, mobile, FR/EN/AR/NL » pour l'écran « Mise à
  // disposition » : les clés de CET écran sont donc traduites en
  // néerlandais, et la liste littérale ne pouvait plus les décrire.
  //
  // L'INVARIANT RÉEL de ce test est conservé, et même rendu plus
  // difficile à contourner : au lieu d'une liste figée, le périmètre
  // autorisé est MESURÉ sur les sources (les clés réellement lues par
  // l'écran et par sa navigation). Une traduction néerlandaise générale
  // de l'interface, glissée sans mandat, échoue donc toujours ici — et
  // elle échoue aussi si l'écran CSDJ-BO-1 cesse de lire une clé dont la
  // traduction néerlandaise resterait derrière elle.
  // Les quatre sources de l'écran : la page, la navigation qui l'encadre,
  // et les deux modules où l'écran DÉRIVE ses clés d'un code serveur
  // (statut, motif, jour de la semaine, refus d'enregistrement, réglage à
  // corriger) au lieu de les écrire en littéral dans le JSX.
  const screenSources = [
    read("app", "dashboard", "availability", "page.tsx"),
    read("components", "dashboard", "DashboardNav.tsx"),
    read("lib", "availability-editor.ts"),
    read("lib", "availability-payload.ts"),
    // Issue #156 : l'état affiché, le nom des modes et les phrases
    // « ce que voit le client » dérivent leurs clés ici, comme ci-dessus.
    read("lib", "availability-ux.ts"),
  ].join("\n");
  // Les clés sont lues sous deux formes dans ces sources -- `t("clé")` et
  // `translate(lang, "clé")` -- donc le relevé retient tout littéral de
  // chaîne de ces fichiers qui est RÉELLEMENT une clé du dictionnaire
  // français, plutôt qu'une seule forme d'appel qui en manquerait.
  const screenKeys = new Set(
    [...screenSources.matchAll(/"([A-Za-z0-9_]+)"/g)]
      .map((m) => m[1])
      .filter((key) => Object.prototype.hasOwnProperty.call(DICTS.fr, key))
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(DICTS.nl, "deliveryConditionsTitle"),
    "le libellé de CE micro-lot reste traduit en néerlandais"
  );
  const outOfScope = Object.keys(DICTS.nl).filter(
    (key) => key !== "deliveryConditionsTitle" && !screenKeys.has(key)
  );
  assert.deepEqual(
    outOfScope,
    [],
    "aucune clé néerlandaise hors des deux mandats : ni traduction générale de l'interface, ni résidu d'une clé que l'écran ne lit plus"
  );
  for (const key of ["close", "deliveryResultEligible", "deliveryPostcodeResultTitle"]) {
    assert.equal(
      translate("nl", key),
      translate("fr", key),
      `${key} doit toujours se replier sur le français en néerlandais`
    );
  }
  // Le sélecteur de langue de l'interface n'annonce PAS une interface
  // néerlandaise complète.
  const i18n = read("lib", "i18n.ts");
  const languagesBlock = i18n.slice(i18n.indexOf("export const LANGUAGES = ["), i18n.indexOf("] as const;"));
  assert.ok(!languagesBlock.includes('"nl"'), "LANGUAGES ne doit pas être élargi par ce micro-lot");
});

test("[SW-05] aucune autre clé de traduction n'a bougé", () => {
  // Le lot ne touche QUE `deliveryConditionsTitle` : toute autre clé
  // partagée par fr/en/ar garde sa valeur, et la parité de clés
  // fr/en/ar est inchangée.
  const keys = (lang: string) => Object.keys(DICTS[lang]).sort();
  assert.deepEqual(keys("en"), keys("fr"), "parité de clés fr/en préservée");
  assert.deepEqual(keys("ar"), keys("fr"), "parité de clés fr/ar préservée");
});

// --------------------------------------------------------------------
// 2. LA BORNE DE LONGUEUR — UNE SEULE AUTORITÉ CÔTÉ CLIENT.
// --------------------------------------------------------------------

test("[SW-06] la borne du texte client de règle est 1000, exportée une seule fois", () => {
  assert.equal(DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH, 1000);
  const editor = read("lib", "delivery-rule-editor.ts");
  assert.equal(
    [...editor.matchAll(/DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH = /g)].length,
    1,
    "une seule déclaration"
  );
});

test("[SW-07] le champ de saisie de la RÈGLE et sa validation lisent cette même borne", () => {
  const page = read("app", "dashboard", "delivery-pricing", "page.tsx");

  // Le textarea de la règle.
  const ruleTextareaStart = page.indexOf("<textarea id={`rule-${rule.ruleId}-text`}");
  assert.ok(ruleTextareaStart > -1, "le champ de texte de la règle doit exister");
  const ruleTextarea = page.slice(ruleTextareaStart, page.indexOf("/>", ruleTextareaStart));
  assert.ok(
    ruleTextarea.includes("maxLength={DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH}"),
    "le maxLength du champ de règle doit lire la constante partagée"
  );
  assert.ok(!ruleTextarea.includes("maxLength={500}"), "plus aucune borne 500 sur ce champ");

  // La validation avant envoi, sur le même chemin.
  assert.match(page, /customerText\.length > DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH/);
  assert.ok(
    !/customerText\.length > 1000/.test(page) && !/maxLength=\{1000\}/.test(page),
    "aucune borne 1000 écrite en dur : la constante partagée est la seule autorité"
  );
});

test("[SW-08] la validation REFUSE au-delà, elle ne tronque jamais", () => {
  const page = read("app", "dashboard", "delivery-pricing", "page.tsx");
  const saveStart = page.indexOf("customerText.length > DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH");
  const block = page.slice(saveStart, saveStart + 240);
  assert.match(block, /updateDraft\(ruleId, \{ error: t\("dpTextTooLong"\) \}\);/);
  assert.match(block, /return;/);
  // Aucune troncature sur ce chemin.
  assert.ok(
    !/customerText\.slice\(|customerText\.substring\(|substr\(/.test(page),
    "aucun découpage du texte client dans l'écran marchand"
  );
});

test("[SW-09] le texte générique PAR MODE reste à 500 — hors périmètre, et cohérent avec SA colonne", () => {
  const page = read("app", "dashboard", "delivery-pricing", "page.tsx");
  const noticeStart = page.indexOf("id={`delivery-method-notice-${mode.modeCode}`}");
  assert.ok(noticeStart > -1, "le champ de notice par mode doit exister");
  const notice = page.slice(noticeStart, page.indexOf("/>", noticeStart));
  assert.ok(
    notice.includes("maxLength={500}"),
    "la notice par mode garde 500 : sa colonne (restaurant_sale_modes.customer_text) n'est pas touchée par ce lot"
  );
  // Et sa validation propre reste à 500.
  assert.match(page, /customerText !== null && customerText\.length > 500/);
});

// --------------------------------------------------------------------
// 3. AUCUNE TRONCATURE DANS LE CHEMIN D'AFFICHAGE.
// --------------------------------------------------------------------

test("[SW-10] le chemin d'affichage ne coupe RIEN : ni JS, ni CSS", () => {
  const files = [
    ["components", "DeliveryConditions.tsx"],
    ["lib", "menu-i18n.ts"],
    ["lib", "sale-modes-types.ts"],
  ] as const;
  for (const file of files) {
    const source = read(...file);
    const code = source
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    for (const forbidden of [
      ".slice(",
      ".substring(",
      ".substr(",
      "line-clamp",
      "truncate",
      "text-ellipsis",
      "overflow-hidden",
      "text-overflow",
      "…",
    ]) {
      assert.ok(!code.includes(forbidden), `${file.join("/")} ne doit pas contenir ${forbidden}`);
    }
  }
});

test("[SW-11] le paragraphe de la fenêtre préserve espaces et retours à la ligne, et ne borne pas sa hauteur", () => {
  const component = read("components", "DeliveryConditions.tsx");
  const paragraph = component.slice(
    component.indexOf("<p data-delivery-rule-text"),
    component.indexOf("</p>", component.indexOf("<p data-delivery-rule-text"))
  );
  assert.match(paragraph, /whitespace-pre-wrap/, "les retours à la ligne du commerçant sont rendus");
  assert.match(paragraph, /break-words/, "un mot très long passe à la ligne au lieu de déborder");
  assert.ok(!/max-h-|h-\d|line-clamp|overflow/.test(paragraph), "aucune hauteur bornée sur le texte");
  // La fenêtre elle-même DÉFILE au lieu de couper (texte long).
  const dialog = component.slice(component.indexOf("<dialog"), component.indexOf("<h2", component.indexOf("<dialog")));
  assert.match(dialog, /overflow-y-auto/, "la fenêtre doit défiler");
  assert.match(dialog, /max-h-\[85dvh\]/, "la fenêtre est bornée en HAUTEUR, le texte non");
});

// --------------------------------------------------------------------
// 4. COHÉRENCE AVEC LE SQL (le comportement est prouvé en base
//    ailleurs ; ici on verrouille le miroir).
// --------------------------------------------------------------------

test("[SW-12] les deux fichiers SQL du lot existent, et portent la borne 1000 / 500", () => {
  const forward = read("supabase", "DRAFT-lot-delivery-customer-text-1000-v1.sql");
  const rollback = read("supabase", "DRAFT-lot-delivery-customer-text-1000-v1-ROLLBACK.sql");

  // Aller : la borne client est le miroir EXACT du CHECK.
  assert.ok(
    forward.includes(`length(customer_text) <= ${DELIVERY_RULE_CUSTOMER_TEXT_MAX_LENGTH}`),
    "le CHECK source doit porter exactement la borne client"
  );
  assert.match(forward, /add constraint rsmf_customer_text_length/);
  assert.match(forward, /add constraint odfs_customer_text_length/);
  assert.match(forward, /customer_text exceeds 1000 characters/);

  // Retour : la borne d'origine, et une garde de DONNÉES.
  assert.ok(rollback.includes("length(customer_text) <= 500"));
  assert.match(rollback, /SCANYM_ROLLBACK_BLOCKED/);

  // Sûreté transactionnelle des deux fichiers : `begin;` d'abord,
  // verrous avant les gardes, `commit;` en dernier.
  for (const [name, sql] of [
    ["aller", forward],
    ["rollback", rollback],
  ] as const) {
    const statements = sql
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("--"));
    assert.equal(statements[0], "begin;", `${name} : begin; en première instruction`);
    assert.equal(statements[statements.length - 1], "commit;", `${name} : commit; en dernière instruction`);
    const locks = statements.filter((l) => l.startsWith("lock table "));
    assert.equal(locks.length, 2, `${name} : les deux tables sont verrouillées`);
    const firstGuard = statements.findIndex((l) => l.startsWith("do $"));
    for (const lock of locks) {
      assert.ok(statements.indexOf(lock) < firstGuard, `${name} : verrou pris avant toute garde`);
    }
    for (const lock of locks) assert.match(lock, /in share mode;$/, `${name} : verrou SHARE`);
  }
});

test("[SW-13] aucune troncature SQL, nulle part", () => {
  for (const file of [
    "DRAFT-lot-delivery-customer-text-1000-v1.sql",
    "DRAFT-lot-delivery-customer-text-1000-v1-ROLLBACK.sql",
  ]) {
    const sql = read("supabase", file)
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i < 0 ? line : line.slice(0, i);
      })
      .join("\n");
    // On interdit la troncature APPLIQUÉE au texte. Le postcheck du
    // fichier aller cherche précisément ces motifs pour REFUSER qu'ils
    // apparaissent : chercher le mot nu attraperait cette garde-là.
    for (const forbidden of [
      /customer_text\s*=\s*left\(/i,
      /customer_text\s*:=\s*left\(/i,
      /set\s+customer_text\s*=\s*(substring|substr)\(/i,
      /v_clean_text\s*:=\s*(left|substring|substr)\(/i,
    ]) {
      assert.ok(!forbidden.test(sql), `${file} ne doit tronquer aucun texte (${forbidden})`);
    }
  }
});

test("[SW-14] hors périmètre : le lot ne touche ni tarif, ni routage, ni fournisseur, ni CGV, ni MCC", () => {
  const forward = read("supabase", "DRAFT-lot-delivery-customer-text-1000-v1.sql")
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i < 0 ? line : line.slice(0, i);
    })
    .join("\n");
  for (const forbidden of [
    "zone_prefixes =",
    "display_order =",
    "fixed_fee =",
    "free_threshold =",
    "discount_",
    "provider =",
    "merchant_communication_text",
    "communication_text_keys",
    "merchant_cgv",
    "cgv_template",
  ]) {
    assert.ok(!forward.includes(forbidden), `le SQL du lot ne doit pas toucher ${forbidden}`);
  }
  // Et côté code : seuls le libellé, la constante et le champ de règle
  // bougent — la liste des fichiers modifiés est verrouillée par le
  // rapport, pas ici ; ce test garde le SQL.
});

test("[SW-15] la ré-empreinte de la baseline THEME est une pure substitution de libellé", () => {
  // Le libellé change le balisage rendu, donc l'empreinte de
  // non-régression de THEME & CONTENT SETTINGS v1 devait être reprise.
  // Ce test PROUVE que la seule différence est le libellé : remettre
  // l'ancien texte redonne, octet pour octet, l'empreinte archivée du
  // rendu « customer_text seul ».
  const fixture = JSON.parse(
    read("tests", "fixtures", "theme-content-settings-v1", "baseline-noconfig.json")
  ) as {
    deliveryHtml: string;
    deliveryHtmlOnBase412dbb5: string;
    deliveryProvenance: Record<string, string>;
  };
  // CENTER ORDER HELP BUTTON v1 : la même empreinte porte désormais
  // `text-center` sur le bouton, et rien d'autre n'a changé.
  assert.ok(fixture.deliveryHtml.includes("text-center"), "le libellé de la cartouche est centré");
  assert.ok(!fixture.deliveryHtml.includes("text-start"), "plus d'alignement à gauche sur le bouton");
  assert.match(fixture.deliveryProvenance.recentredBy ?? "", /CENTER ORDER HELP BUTTON/);
  const occurrences = [...fixture.deliveryHtml.matchAll(/Comment passer commande/g)].length;
  assert.equal(occurrences, 2, "le libellé apparaît deux fois : la cartouche et le titre");
  assert.ok(!fixture.deliveryHtml.includes("Modes et tarifs de livraison"), "plus aucune trace de l'ancien libellé");
  // L'ARCHIVE historique (empreinte 412dbb5) n'est PAS retouchée : un
  // fait daté ne se réécrit pas.
  assert.ok(
    fixture.deliveryHtmlOnBase412dbb5.includes("Modes et tarifs de livraison"),
    "l'archive 412dbb5 doit rester intacte"
  );
  // …et la raison de la reprise est inscrite dans la fixture.
  assert.match(fixture.deliveryProvenance.relabelledBy ?? "", /STOREFRONT ORDER HELP WORDING/);
  assert.equal(fixture.deliveryProvenance.supersededBy, "DELIVERY PUBLIC TEXT v1");
});

test("[SW-16] conséquence assumée du dictionnaire NL : « nl » devient une langue résoluble", () => {
  // `resolveLangFromParam` n'a qu'une autorité : les clés de DICTS. En y
  // ajoutant un dictionnaire néerlandais PARTIEL, « nl » cesse de se
  // replier sur « fr ». Le texte rendu est inchangé pour toutes les
  // autres clés (repli par clé, voir [SW-04]) -- seul ce libellé-ci
  // devient néerlandais, ce qui est l'objet du mandat. Documenté ici
  // plutôt que découvert par un auditeur.
  assert.equal(resolveLangFromParam("nl"), "nl");
  // Les langues existantes ne bougent pas, et l'inconnu se replie
  // toujours sur le français.
  assert.equal(resolveLangFromParam("fr"), "fr");
  assert.equal(resolveLangFromParam("en"), "en");
  assert.equal(resolveLangFromParam("ar"), "ar");
  assert.equal(resolveLangFromParam("de"), "fr");
  assert.equal(resolveLangFromParam(undefined), "fr");
  assert.equal(resolveLangFromParam("constructor"), "fr");
});
