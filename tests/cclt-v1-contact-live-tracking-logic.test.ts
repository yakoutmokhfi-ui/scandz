import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// ====================================================================
// Scanym — CUSTOMER CONTACT + LIVE TRACKING v1
// Logique PURE + gardes structurelles du lot.
// Client d'exemple : MYRIAM.
// ====================================================================

const {
  isWhatsappEnabled,
  withoutUnusedWhatsapp,
  publicContactOf,
  telHref,
  isValidPublicPhone,
  isValidPublicEmail,
} = await import("../lib/customer-contact.ts");
const {
  NORMAL_PROGRESSION,
  CANONICAL_ORDER_STATUSES,
  timelineStepLabelKey,
  statusLabelKeyForServiceMode,
} = await import("../lib/tracking/status.ts");
const { translate } = await import("../lib/i18n.ts");

const VALID_NUMBER = "+33600000000";

// --------------------------------------------------------------------
// A. WhatsApp optionnel
// --------------------------------------------------------------------

test("CCLT-WA-01 WhatsApp ON : drapeau vrai + numéro valide => utilisé", () => {
  assert.equal(isWhatsappEnabled({ whatsapp_number: VALID_NUMBER, whatsapp_enabled: true }), true);
});

test("CCLT-WA-02 WhatsApp OFF : drapeau faux => jamais utilisé, même avec un numéro valide", () => {
  assert.equal(isWhatsappEnabled({ whatsapp_number: VALID_NUMBER, whatsapp_enabled: false }), false);
});

test("CCLT-WA-03 aucun repli caché : numéro vide/invalide => WhatsApp NON utilisé, même si le drapeau est vrai", () => {
  for (const n of ["", "   ", "abc", "0612345678", "+0123"]) {
    assert.equal(isWhatsappEnabled({ whatsapp_number: n, whatsapp_enabled: true }), false, n);
  }
  assert.equal(isWhatsappEnabled(null), false);
  assert.equal(isWhatsappEnabled(undefined), false);
});

test("CCLT-WA-04 lot SQL non appliqué (drapeau absent) => comportement historique conservé (activé)", () => {
  assert.equal(isWhatsappEnabled({ whatsapp_number: VALID_NUMBER }), true);
});

test("CCLT-WA-05 WhatsApp OFF : le numéro ne voyage pas jusqu'au navigateur ; objet d'origine intact", () => {
  const config = { whatsapp_number: VALID_NUMBER, whatsapp_enabled: false, currency: "EUR" };
  const out = withoutUnusedWhatsapp(config);
  assert.equal(out.whatsapp_number, "");
  assert.equal(out.whatsapp_enabled, false);
  assert.equal(out.currency, "EUR");
  assert.equal(config.whatsapp_number, VALID_NUMBER, "aucune mutation de l'entrée");
  const on = { whatsapp_number: VALID_NUMBER, whatsapp_enabled: true };
  assert.equal(withoutUnusedWhatsapp(on), on, "WhatsApp ON : configuration inchangée");
});

test("CCLT-WA-06 textes sans WhatsApp : aucune clé de repli ne mentionne WhatsApp (fr/en/ar)", () => {
  for (const lang of ["fr", "en", "ar"]) {
    for (const key of ["sendOrderNoWhatsapp", "orderNoticeNoWhatsapp", "privacyNoteNoWhatsapp", "confirmSubtitleNoWhatsapp"]) {
      const v = translate(lang, key, { name: "Épicerie Alpha" });
      assert.ok(v && v !== key, `${lang}.${key} existe`);
      assert.equal(/whats\s*app|واتساب|wa\.me/i.test(v), false, `${lang}.${key} ne mentionne pas WhatsApp`);
    }
  }
});

test("CCLT-WA-07 composants client : chaque texte/lien WhatsApp est conditionné par la SEULE autorité isWhatsappEnabled", () => {
  const menuView = readFileSync("components/MenuView.tsx", "utf8");
  const cart = readFileSync("components/CartPanel.tsx", "utf8");
  const confirm = readFileSync("components/OrderConfirmation.tsx", "utf8");
  for (const [name, src] of [["MenuView", menuView], ["CartPanel", cart], ["OrderConfirmation", confirm]] as const) {
    assert.match(src, /isWhatsappEnabled\(restaurant\.config\)/, `${name} lit l'autorité unique`);
  }
  // MenuView : buildWhatsAppUrl / window.open / markWhatsappOpened
  // uniquement dans la branche `if (whatsappEnabled)`.
  const flowStart = menuView.indexOf("function completeOrderFlow(");
  const guard = menuView.indexOf("if (whatsappEnabled) {", flowStart);
  const build = menuView.indexOf("buildWhatsAppUrl(", flowStart);
  const mark = menuView.indexOf("void markWhatsappOpened(", flowStart);
  const closing = menuView.indexOf("setConfirmedContext(frozenOrderContext);", flowStart);
  assert.ok(flowStart > 0 && guard > flowStart && build > guard && mark > build && closing > mark);
  assert.ok(menuView.slice(mark, closing).includes("}"), "la branche WhatsApp est fermée avant la confirmation");
  // CartPanel : la couleur WhatsApp n'est jamais appliquée hors branche activée.
  for (const m of cart.matchAll(/bg-\[#25D366\]/g)) {
    const before = cart.slice(Math.max(0, (m.index ?? 0) - 400), m.index);
    assert.ok(/whatsappEnabled/.test(before), "couleur WhatsApp toujours sous condition whatsappEnabled");
  }
});

// --------------------------------------------------------------------
// B. Contact public
// --------------------------------------------------------------------

test("CCLT-CONTACT-01 contact public : normalisé, null si vide ; tel: sans ponctuation", () => {
  assert.deepEqual(publicContactOf({ public_phone: " +33 1 23 45 67 89 ", public_email: "contact@alpha.example" }), {
    phone: "+33 1 23 45 67 89",
    email: "contact@alpha.example",
  });
  assert.equal(publicContactOf({ public_phone: " ", public_email: null }), null);
  assert.equal(publicContactOf(null), null);
  assert.equal(telHref("+33 (1) 23.45-67 89"), "tel:+33123456789");
  assert.equal(telHref("01 23 45 67 89"), "tel:0123456789");
});

test("CCLT-CONTACT-02 validations MIROIR des contraintes SQL", () => {
  for (const ok of ["", "+33 1 23 45 67 89", "0123456789", "+213 (0) 550.00.00.00"]) {
    assert.equal(isValidPublicPhone(ok), true, ok);
  }
  for (const bad of ["appelez-moi", "12", "+33 1 23 45 67 89 poste 4", "-0123456789"]) {
    assert.equal(isValidPublicPhone(bad), false, bad);
  }
  for (const ok of ["", "myriam@example.com", "contact@alpha.example"]) {
    assert.equal(isValidPublicEmail(ok), true, ok);
  }
  for (const bad of ["pas-un-email", "a@b", "a b@c.fr", `${"x".repeat(250)}@a.fr`]) {
    assert.equal(isValidPublicEmail(bad), false, bad);
  }
  const sql = readFileSync("supabase/DRAFT-lot-customer-contact-live-tracking-v1.sql", "utf8");
  assert.ok(sql.includes("'^\\+?[0-9][0-9 .()-]{5,28}[0-9]$'"), "même motif téléphone côté SQL");
});

// --------------------------------------------------------------------
// C. Progression du suivi par mode
// --------------------------------------------------------------------

test("CCLT-PROG-01 la frise reste EXACTEMENT les 5 statuts réels -- aucune étape inventée (livraison, livreur, prestataire)", () => {
  assert.deepEqual([...NORMAL_PROGRESSION], ["new", "accepted", "preparing", "ready", "completed"]);
  assert.deepEqual([...CANONICAL_ORDER_STATUSES], ["new", "accepted", "preparing", "ready", "completed", "rejected", "cancelled"]);
});

test("CCLT-PROG-02 retrait (pickup/click_collect) : jamais un libellé de livraison dans la frise", () => {
  for (const mode of ["pickup", "click_collect"]) {
    const labels = NORMAL_PROGRESSION.map((s) => translate("fr", timelineStepLabelKey(s, mode)));
    assert.deepEqual(labels, ["Commande reçue", "Commande acceptée", "En préparation", "Prête pour le retrait", "Terminée"]);
    assert.equal(/livr|prise en charge|delivery/i.test(labels.join(" ")), false, mode);
  }
});

test("CCLT-PROG-03 livraison : étape « prête » adaptée, aucune promesse de livreur/ETA", () => {
  const labels = NORMAL_PROGRESSION.map((s) => translate("fr", timelineStepLabelKey(s, "delivery")));
  assert.equal(labels[3], "Prête, en attente de prise en charge");
  assert.equal(/retrait|minutes|heure|livreur|en route/i.test(labels.join(" ")), false);
});

test("CCLT-PROG-04 mode inconnu : repli générique (jamais une erreur, jamais un libellé d'un autre mode)", () => {
  assert.equal(timelineStepLabelKey("ready", "drone"), "trackingStatus_ready");
  for (const s of NORMAL_PROGRESSION) {
    assert.equal(timelineStepLabelKey(s, "table"), statusLabelKeyForServiceMode(s, "table"), "même autorité que le badge");
  }
});

test("CCLT-PROG-05 chaque clé produite pour les 5 modes existe en fr/en/ar", () => {
  for (const mode of ["table", "pickup", "click_collect", "room_service", "delivery", "unknown"]) {
    for (const s of NORMAL_PROGRESSION) {
      const key = timelineStepLabelKey(s, mode);
      for (const lang of ["fr", "en", "ar"]) {
        const v = translate(lang, key);
        assert.ok(v && v !== key, `${lang}.${key}`);
      }
    }
  }
});

// --------------------------------------------------------------------
// F. Sécurité / tenant (garde structurelle, complète le harnais SQL)
// --------------------------------------------------------------------

test("CCLT-SEC-01 contexte de suivi : MÊME prédicat de capacité que v3.1, et la lecture principale n'est pas modifiée", () => {
  const lot = readFileSync("supabase/DRAFT-lot-customer-contact-live-tracking-v1.sql", "utf8");
  const v31 = readFileSync("supabase/DRAFT-lot-customer-tracking-capability-v3-1.sql", "utf8");
  const predicate = [
    "where c.id = p_capability_id",
    "and c.order_id = p_order_id",
    "and o.id = p_order_id",
    "and c.secret_hash is not null",
    "and (c.expires_at is null or c.expires_at > pg_catalog.now())",
    "and pg_catalog.length(p_secret) = 64",
    "and c.secret_hash = pg_catalog.sha256(pg_catalog.convert_to(p_secret, 'UTF8'));",
  ];
  for (const line of predicate) {
    assert.ok(v31.includes(line), `v3.1 : ${line}`);
    assert.ok(lot.includes(line), `lot : ${line}`);
  }
  assert.equal(/get_order_tracking_by_capability\s*\(/.test(lot.replace(/--.*$/gm, "")), false, "v3.1 jamais redéfinie");
  const ctx = readFileSync("lib/server/tracking-customer-context.ts", "utf8");
  assert.match(ctx, /^import "server-only";/m);
  assert.equal(/whatsapp/i.test(ctx.replace(/\/\*[\s\S]*?\*\//g, "")), false, "le contexte de suivi ne lit jamais WhatsApp");
  assert.match(ctx, /bound_order_id\.toLowerCase\(\) !== input\.orderId\.toLowerCase\(\)/, "liaison commande re-vérifiée côté serveur Next");
});

test("CCLT-SEC-02 écritures marchandes : owner/manager, aucune écriture anon, aucun contournement opérateur", () => {
  const lot = readFileSync("supabase/DRAFT-lot-customer-contact-live-tracking-v1.sql", "utf8");
  for (const fn of [
    "update_restaurant_whatsapp_enabled(uuid, boolean)",
    "update_restaurant_public_contact(uuid, text, text)",
  ]) {
    assert.ok(lot.includes(`revoke all on function public.${fn} from public, anon;`), fn);
    assert.ok(lot.includes(`grant execute on function public.${fn} to authenticated;`), fn);
  }
  assert.equal(/is_scanym_operator/.test(lot.replace(/--.*$/gm, "")), false, "aucun contournement opérateur");
  assert.equal((lot.match(/ru\.role = any \(array\['owner', 'manager'\]\)/g) ?? []).length, 2);
});

// --------------------------------------------------------------------
// G. Données d'exemple : MYRIAM (mandat §G -- le prénom du CIO n'est
//    jamais un nom client d'exemple/test/démo).
// --------------------------------------------------------------------

const FORBIDDEN_SAMPLE_NAME = ["Yak", "out"].join("");

test("CCLT-FIXTURE-01 fichiers de ce lot : client d'exemple MYRIAM, jamais le prénom interdit ; placeholder client = Myriam", () => {
  const lotFiles = [
    ...readdirSync("tests").filter((f) => f.startsWith("cclt-v1-")).map((f) => `tests/${f}`),
    "supabase/tests/customer-contact-live-tracking-v1-check.sh",
    "supabase/DRAFT-lot-customer-contact-live-tracking-v1.sql",
    "supabase/DRAFT-lot-customer-contact-live-tracking-v1-rollback.sql",
    "lib/customer-contact.ts",
    "lib/server/tracking-customer-context.ts",
  ];
  assert.ok(lotFiles.length >= 8, `fichiers du lot : ${lotFiles.length}`);
  const forbidden = new RegExp(FORBIDDEN_SAMPLE_NAME, "i");
  let myriam = 0;
  for (const f of lotFiles) {
    const src = readFileSync(f, "utf8");
    assert.equal(forbidden.test(src), false, `${f} ne doit pas utiliser le prénom interdit`);
    if (/myriam/i.test(src)) myriam += 1;
  }
  assert.ok(myriam >= 3, "les fixtures du lot utilisent MYRIAM");
  const selector = readFileSync("components/FulfillmentSelector.tsx", "utf8");
  assert.match(selector, /placeholder: "Myriam",/);
  assert.equal(new RegExp(`placeholder: "${FORBIDDEN_SAMPLE_NAME}"`).test(selector), false);
});

