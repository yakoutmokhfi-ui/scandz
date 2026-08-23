/**
 * Sélection de classe du bandeau de statut livraison
 * (good/warn/défaut), extraite en fonction pure et testable --
 * corrige BG-02 (contre-audit Work) : prouve, plutôt que de
 * simplement inspecter visuellement, que le remplacement de bg-white
 * par bg-crema (UIFIX-01) n'a modifié AUCUNE des 3 branches de
 * décision d'origine (good/warn/défaut), uniquement la valeur de
 * chaîne à l'intérieur de la branche "défaut" -- voir
 * tests/ui-contrast-fix.test.ts pour la preuve empirique.
 *
 * Fichier .ts séparé (jamais dans le composant .tsx) : une fonction
 * pure sans JSX doit être directement testable sans passer par le
 * rendu DOM complet du composant, même patron que lib/delivery.ts.
 */
export function getFulfillmentToneClass(tone: string | null | undefined): string {
  if (tone === "good") return "bg-green-50 text-green-800";
  if (tone === "warn") return "bg-amber-50 text-amber-900";
  // Corrige UIFIX-01 : bg-crema (= var(--sc-bg)) réaligne fond et
  // texte sur la même source de contraste (text-ink-on-bg-muted est
  // également calculé contre --sc-bg, jamais contre du blanc
  // littéral).
  return "bg-crema text-ink-on-bg-muted";
}
