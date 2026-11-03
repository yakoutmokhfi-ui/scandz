// Lecteur partagé par les scénarios Playwright et leur fixture DOM de régression.
// Le texte de la frise ne représente jamais le statut courant.
export async function trackingCurrentStatus(page) {
  const badge = page.locator('main p[aria-live="polite"]');
  if (await badge.count() !== 1 || !(await badge.isVisible())) return "";
  return (await badge.innerText()).replace(/\s+/g, " ").trim();
}
