// ====================================================================
// CSDJ2-R5 (PR #160, HEAD audité d28bea9) -- OPÉRATEURS STRUCTURELS.
//
// POURQUOI CE MODULE : la revue R4 mutait les VALEURS des chemins présents
// dans des réponses types. Elle ne pouvait donc pas créer une réponse dont la
// STRUCTURE diffère (une date éligible de plus, une liste d'offres vide pour
// UNE AUTRE date que la date dérivée, une clé retirée, un doublon, un
// réordonnancement) : la base « dérivée » n'avait qu'une seule date. Ici :
//  - des bases VALIDES à 1, 2 ou 3 dates pour chaque politique ;
//  - des opérateurs qui changent le NOMBRE, la POSITION et le CONTENU des
//    dates et de leurs listes d'offres.
// Le verdict reste celui de l'oracle R4 (`refVerdict`, écrit à part du code).
// Aucun import du code de production.
// ====================================================================
import { BASES, clone, refVerdict, type Json } from "./_csdj2-r4-oracle.ts";

export const MISSING = Symbol("missing");
type V = Json | typeof MISSING;

const DAY = (s: string, e: string) => ({ slot_key: null, starts_at: s, ends_at: e });
const SLOT = (k: string, s: string, e: string) => ({ slot_key: k, starts_at: s, ends_at: e });

/** Ajoute des dates VALIDES (une liste d'offres bien formée pour la politique) à une base. */
function withDates(base: Json[], extra: Array<[string, Json]>): Json[] {
  const d = clone(base);
  const r: any = d[0];
  for (const [date, offers] of extra) {
    r.eligible_dates.push(date);
    r.offers[date] = clone(offers);
  }
  return d;
}

export const MULTI_BASES: Record<string, Json[]> = {
  derived2: withDates(BASES.derived, [["2026-10-25", [DAY("09:00", "18:00")]]]),
  derived3: withDates(BASES.derived, [["2026-10-25", [DAY("09:00", "18:00")]], ["2026-10-27", [DAY("10:00", "12:00"), DAY("14:00", "17:00")]]]),
  selNone3: withDates(BASES.selNone, [["2026-10-27", [DAY("08:00", "12:00")]]]),
  fixed3: withDates(BASES.fixed, [["2026-10-27", [SLOT("afternoon", "14:00", "18:00")]]]),
  window3: withDates(BASES.window, [["2026-10-27", [DAY("09:00", "10:00")]]]),
};
/** Toutes les bases (R4 + multi-dates) : pour les tests R5. */
export const ALL_BASES: Record<string, Json[]> = { ...BASES, ...MULTI_BASES };

/** Les valeurs possibles de « la liste d'offres d'une date » (valides ET invalides). */
export function offersClasses(policy: "derived" | "selNone" | "fixed" | "window"): Array<[string, V]> {
  const valid: Json =
    policy === "fixed" ? [SLOT("morning", "09:00", "12:00")]
    : policy === "window" ? [DAY("09:00", "10:30")]
    : [DAY("09:00", "18:00")];
  return [
    ["liste vide []", []], ["null", null], ["objet {}", {}], ["texte", "bad"], ["nombre", 42], ["booléen", false],
    ["[null]", [null]], ["[{}]", [{}]], ["[[]]", [[]]], ["[texte]", ["09:00"]],
    ["offre inversée", [DAY("18:00", "09:00")]], ["offre 25:00", [DAY("09:00", "25:00")]], ["offre avec secondes", [DAY("09:00:00", "18:00:00")]],
    ["offre clé 42", [{ slot_key: 42, starts_at: "09:00", ends_at: "18:00" }]],
    ["offre sans clé", [{ starts_at: "09:00", ends_at: "18:00" }]],
    ["offre valide + vide", [...(valid as any[]), {}]],
    ["valide (contrôle positif)", valid],
    ["clé ABSENTE", MISSING],
  ];
}
export const policyOf = (name: string) => (name.startsWith("derived") ? "derived" : name.startsWith("selNone") ? "selNone" : name.startsWith("fixed") ? "fixed" : "window") as "derived" | "selNone" | "fixed" | "window";

/** Variantes STRUCTURELLES d'une base valide : [libellé, réponse]. */
export function structuralVariants(baseName: string, base: Json[]): Array<[string, Json[]]> {
  const out: Array<[string, Json[]]> = [];
  const pol = policyOf(baseName);
  const r0: any = base[0];
  const dates: string[] = r0?.eligible_dates;
  // Une base déjà dégradée (liste de dates absente, offres non objet) n'a plus de structure à transformer.
  if (!Array.isArray(dates) || r0.offers === null || typeof r0.offers !== "object" || Array.isArray(r0.offers)) return out;
  const mk = (fn: (r: any) => void): Json[] => { const d = clone(base); fn(d[0]); return d; };
  const put = (r: any, date: string, v: V) => { if (v === MISSING) delete r.offers[date]; else r.offers[date] = clone(v as Json); };
  const NEW = "2026-10-30";

  // 1. Une date éligible de plus, à CHAQUE position, avec CHAQUE forme d'offres ; la première date suit ou non.
  for (let at = 0; at <= dates.length; at += 1) {
    for (const [lab, v] of offersClasses(pol)) {
      for (const follow of at === 0 ? [true, false] : [true]) {
        out.push([`+date@${at}${at === 0 ? (follow ? "(première=nouvelle)" : "(première inchangée)") : ""} offres=${lab}`, mk((r) => {
          r.eligible_dates.splice(at, 0, NEW);
          put(r, NEW, v);
          if (at === 0 && follow) r.first_eligible_date = NEW;
        })]);
      }
    }
  }
  // 1bis. La date ajoutée n'est que dans `offers` (clé en trop), ou que dans `eligible_dates` (clé manquante).
  for (const [lab, v] of offersClasses(pol)) {
    out.push([`clé d'offres EN TROP offres=${lab}`, mk((r) => { put(r, NEW, v); })]);
    out.push([`date SANS clé d'offres (date ajoutée, clé absente) [${lab} ignoré]`, mk((r) => { r.eligible_dates.push(NEW); })]);
  }
  // 2. Chaque date existante reçoit chaque forme d'offres (première, milieu, dernière).
  dates.forEach((d, i) => {
    for (const [lab, v] of offersClasses(pol)) out.push([`offres[${i}=${d}] <- ${lab}`, mk((r) => put(r, d, v))]);
    // 3. Retrait d'une date de l'un seulement des deux côtés, ou des deux.
    out.push([`retirer la date ${i} de eligible_dates SEULEMENT`, mk((r) => { r.eligible_dates.splice(i, 1); if (i === 0) r.first_eligible_date = r.eligible_dates[0] ?? null; })]);
    out.push([`retirer la clé d'offres ${i} SEULEMENT`, mk((r) => { delete r.offers[d]; })]);
    out.push([`retirer la date ${i} des DEUX côtés (première recalculée)`, mk((r) => { r.eligible_dates.splice(i, 1); delete r.offers[d]; r.first_eligible_date = r.eligible_dates[0] ?? null; })]);
    out.push([`retirer la date ${i} des DEUX côtés (première NON recalculée)`, mk((r) => { r.eligible_dates.splice(i, 1); delete r.offers[d]; })]);
    // 4. Doublon.
    out.push([`dupliquer la date ${i}`, mk((r) => { r.eligible_dates.splice(i + 1, 0, d); })]);
    // 7. Première date forcée.
    if (i > 0) out.push([`first_eligible_date <- date ${i}`, mk((r) => { r.first_eligible_date = d; })]);
  });
  // 6. Réordonnancement (l'ordre n'est pas imposé : valide seulement si la première date suit).
  for (let i = 0; i < dates.length; i += 1) {
    for (let j = i + 1; j < dates.length; j += 1) {
      out.push([`échanger les dates ${i}<->${j} (première inchangée)`, mk((r) => { [r.eligible_dates[i], r.eligible_dates[j]] = [r.eligible_dates[j], r.eligible_dates[i]]; })]);
      out.push([`échanger les dates ${i}<->${j} (première suit)`, mk((r) => { [r.eligible_dates[i], r.eligible_dates[j]] = [r.eligible_dates[j], r.eligible_dates[i]]; r.first_eligible_date = r.eligible_dates[0]; })]);
    }
  }
  // 8. Liste de dates vidée / dates en trop dans offers.
  out.push(["eligible_dates vide, offres intactes", mk((r) => { r.eligible_dates = []; })]);
  out.push(["eligible_dates vide, offres vides, première nulle", mk((r) => { r.eligible_dates = []; r.offers = {}; r.first_eligible_date = null; })]);
  return out;
}

/** Contrôle de l'oracle : toutes les bases R5 sont valides pour l'oracle. */
export function assertMultiBasesValid() {
  for (const [n, b] of Object.entries(MULTI_BASES)) {
    const v = refVerdict(b);
    if (v.cls === "closed") throw new Error(`base multi-dates ${n} jugée invalide par l'oracle`);
  }
}
