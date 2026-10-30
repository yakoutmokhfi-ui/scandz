// Issue #191 — amener le client au premier champ à corriger.
//
// Le « premier » champ est le premier dans l'ORDRE DU DOCUMENT (ordre
// visuel du formulaire), jamais dans l'ordre d'un objet d'erreurs.
// Le focus est donné sans saut brutal (`preventScroll`), puis le champ
// est centré dans la zone visible. Aucune valeur saisie n'est touchée.
export function focusFirstInvalidField(root: ParentNode | null): HTMLElement | null {
  if (!root) return null;
  const target = root.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!target) return null;
  target.focus({ preventScroll: true });
  if (typeof target.scrollIntoView === "function") {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  return target;
}
