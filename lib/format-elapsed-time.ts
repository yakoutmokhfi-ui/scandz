/**
 * SCANYM BACKOFFICE — TICKET AGE / ELAPSED TIME DISPLAY FIX (v1)
 *
 * Formate une durée écoulée (en minutes entières) en une chaîne
 * lisible en FRANÇAIS UNIQUEMENT (mandat, littéral : "French display
 * only for this lot") -- jamais un arrondi vers une unité plus
 * grossière, toujours basé sur la durée écoulée réelle.
 *
 * Règles exactes (mandat) :
 * 1. < 60 minutes -> "{n} min" (jamais de zéro-padding sur une valeur
 *    de minutes autonome).
 * 2. >= 60 minutes et < 24 heures -> "{h}h {mm}min" (minutes
 *    TOUJOURS zéro-paddées sur 2 chiffres dès que des heures ou des
 *    jours sont affichés).
 * 3. >= 24 heures -> "{j}j {h}h {mm}min" (jamais de préfixe "0j"
 *    superflu -- seulement lorsque des jours entiers sont réellement
 *    écoulés).
 *
 * Exemples exacts vérifiés (mandat) :
 *   1285 -> "21h 25min"
 *   15559 -> "10j 19h 19min"
 *   16958 -> "11j 18h 38min"
 *   1440 -> "1j 0h 00min"
 *   1439 -> "23h 59min"
 *
 * Portée DISPLAY ONLY -- n'affecte jamais le calcul de l'âge lui-même
 * (voir formatElapsedMinutesFr, appelée avec une valeur déjà calculée
 * depuis `created_at`), ni le tri, ni la logique SLA/métier.
 *
 * Comportement en cas de valeur non finie (ex. `created_at` manquant/
 * invalide en amont, produisant `NaN`/`Infinity`/`-Infinity`) : voir
 * CORRECTIF v1.1 ci-dessous -- jamais un rendu littéral incorrect,
 * jamais une durée fictive inventée.
 */
/**
 * CORRECTIF v1.1 (TICKET ELAPSED TIME DISPLAY — INVALID TIMESTAMP
 * FALLBACK) : une durée non finie (`NaN`, `Infinity`, `-Infinity`)
 * -- produite lorsque `created_at` est invalide/manquant en amont --
 * ne doit JAMAIS être rendue littéralement ("NaNh NaNmin",
 * "Infinityh Infinitymin", etc.), ni être remplacée par une durée
 * FICTIVE telle que "0 min" (qui affirmerait faussement une commande
 * fraîche). Utilise la convention de repli DÉJÀ ÉTABLIE dans le
 * produit pour une valeur indisponible -- le tiret cadratin "—",
 * déjà utilisé de façon cohérente ailleurs dans le backoffice
 * (app/admin/establishments/page.tsx, .../cockpit/page.tsx,
 * app/dashboard/catalogue-import/page.tsx) -- jamais un nouveau
 * placeholder inventé pour ce lot.
 */
export function formatElapsedMinutesFr(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes)) {
    return "—";
  }
  const minutes = Math.max(0, Math.floor(totalMinutes));

  if (minutes < 60) {
    return `${minutes} min`;
  }

  const days = Math.floor(minutes / 1440);
  const remainderAfterDays = minutes % 1440;
  const hours = Math.floor(remainderAfterDays / 60);
  const mins = remainderAfterDays % 60;
  const paddedMins = String(mins).padStart(2, "0");

  if (days >= 1) {
    return `${days}j ${hours}h ${paddedMins}min`;
  }
  return `${hours}h ${paddedMins}min`;
}
