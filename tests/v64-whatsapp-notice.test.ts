import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ====================================================================
// Avertissement WhatsApp avant transmission de la commande (corrective
// V64 — notice). Vérifie : présence du message avant le bouton final,
// absence de duplication de la logique WhatsApp, absence d'appel
// Supabase direct ajouté, symétrie FR/EN/AR.
// ====================================================================

function extractDictKeys(source: string, name: string): Set<string> {
  const start = source.indexOf(`const ${name}: Dict = {`);
  assert.ok(start >= 0, `dictionnaire '${name}' introuvable dans lib/i18n.ts`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = source.slice(braceStart, i + 1);
  const keys = [...body.matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  return new Set(keys);
}

test("whatsapp notice: la clé whatsappNotice existe en fr/en/ar", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const fr = extractDictKeys(source, "fr");
  const en = extractDictKeys(source, "en");
  const ar = extractDictKeys(source, "ar");
  assert.ok(fr.has("whatsappNotice"));
  assert.ok(en.has("whatsappNotice"));
  assert.ok(ar.has("whatsappNotice"));
});

test("whatsapp notice: les 3 traductions ne sont pas vides et diffèrent entre langues", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const extractValue = (dict: string, key: string) => {
    const dictStart = source.indexOf(`const ${dict}: Dict = {`);
    const keyLine = source.indexOf(`\n  ${key}:`, dictStart);
    assert.ok(keyLine >= 0, `clé '${key}' introuvable dans '${dict}'`);
    const lineEnd = source.indexOf("\n", keyLine + 1);
    return source.slice(keyLine, lineEnd);
  };
  const fr = extractValue("fr", "whatsappNotice");
  const en = extractValue("en", "whatsappNotice");
  const ar = extractValue("ar", "whatsappNotice");
  assert.ok(fr.length > 20);
  assert.ok(en.length > 20);
  assert.ok(ar.length > 20);
  assert.notEqual(fr, en);
  assert.notEqual(fr, ar);
});

test("whatsapp notice: le bouton final n'affirme plus un envoi automatique (fr)", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  const fr = extractDictKeys(source, "fr");
  assert.ok(fr.has("sendOrder"));
  // Version initiale ("Envoyer la commande sur WhatsApp") et version
  // intermédiaire ("Continuer sur WhatsApp") laissaient toutes deux
  // entendre, à des degrés différents, que la commande n'était liée
  // qu'à l'action WhatsApp. Le texte final doit refléter que
  // l'enregistrement dans Scanym précède l'ouverture de WhatsApp.
  assert.ok(
    !source.includes('sendOrder: "Envoyer la commande sur WhatsApp"'),
    "le texte du bouton doit avoir été reformulé"
  );
  assert.ok(
    source.includes('sendOrder: "Enregistrer et continuer sur WhatsApp"'),
    "le bouton doit mentionner explicitement l'enregistrement"
  );
});

test("whatsapp notice: le message explique que l'enregistrement précède l'ouverture de WhatsApp (fr/en/ar)", () => {
  const source = readFileSync("lib/i18n.ts", "utf8");
  assert.ok(
    source.includes("votre commande sera enregistrée dans Scanym"),
    "le texte fr doit mentionner l'enregistrement avant WhatsApp"
  );
  assert.ok(
    source.includes("your order will be recorded in Scanym"),
    "le texte en doit mentionner l'enregistrement avant WhatsApp"
  );
  assert.ok(
    source.includes("سيتم تسجيل طلبك في Scanym"),
    "le texte ar doit mentionner l'enregistrement avant WhatsApp"
  );
});

test("whatsapp notice: CartPanel affiche le message juste avant le bouton d'envoi, sans infobulle", () => {
  const src = readFileSync("components/CartPanel.tsx", "utf8");
  const noticeIndex = src.indexOf('t("whatsappNotice")');
  const buttonIndex = src.indexOf("onClick={onSendOrder}");
  assert.ok(noticeIndex >= 0, "le message whatsappNotice doit être affiché");
  assert.ok(buttonIndex >= 0, "le bouton d'envoi doit exister");
  assert.ok(
    noticeIndex < buttonIndex,
    "le message doit apparaître avant le bouton dans le JSX, pas après"
  );
  // Pas d'infobulle : ni attribut title, ni composant Tooltip autour
  // du message ajouté.
  const around = src.slice(Math.max(0, noticeIndex - 200), buttonIndex);
  assert.ok(!/title=/.test(around), "le message ne doit pas être dans une infobulle");
});

test("whatsapp notice: la logique de génération du lien WhatsApp n'est pas dupliquée", () => {
  const cartPanel = readFileSync("components/CartPanel.tsx", "utf8");
  const menuView = readFileSync("components/MenuView.tsx", "utf8");
  // buildWhatsAppUrl doit rester le seul point de construction du
  // lien ; CartPanel ne doit pas s'en charger lui-même.
  assert.ok(!/buildWhatsAppUrl/.test(cartPanel));
  assert.ok(/buildWhatsAppUrl/.test(menuView));
  // Un seul appel dans tout le parcours de commande.
  const occurrences = [...menuView.matchAll(/buildWhatsAppUrl\(/g)].length;
  assert.equal(occurrences, 1);
});

test("whatsapp notice: aucun appel Supabase direct dans CartPanel ou MenuView", () => {
  const cartPanel = readFileSync("components/CartPanel.tsx", "utf8");
  const menuView = readFileSync("components/MenuView.tsx", "utf8");
  for (const src of [cartPanel, menuView]) {
    assert.ok(!/supabase\s*\.\s*auth\s*\./.test(src));
    assert.ok(!/supabase\s*\.\s*from\s*\(/.test(src));
    assert.ok(!/supabase\s*\.\s*channel\s*\(/.test(src));
  }
});
