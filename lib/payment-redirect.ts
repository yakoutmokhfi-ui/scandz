/**
 * PAYMENT P4-A — REDIRECTION VERS LA PAGE DE PAIEMENT MONETICO.
 *
 * Monetico attend un formulaire HTML envoyé en POST (paiement.cgi) avec
 * les champs signés côté serveur (MAC). Le navigateur ne modifie, n'ajoute
 * ni ne retire AUCUN champ : il rejoue exactement ce que la route
 * `/api/payments/monetico/checkout` a renvoyé.
 *
 * Fonction PURE de construction (testable sans navigateur réel) +
 * fonction d'envoi, séparées pour que les tests puissent vérifier le
 * formulaire sans déclencher de navigation.
 */

export function buildPaymentRedirectForm(
  doc: Document,
  submissionUrl: string,
  fields: Record<string, string>
): HTMLFormElement {
  if (!/^https:\/\//.test(submissionUrl)) {
    throw new Error("PAYMENT_REDIRECT_INSECURE_URL");
  }
  const form = doc.createElement("form");
  form.method = "POST";
  form.action = submissionUrl;
  form.setAttribute("accept-charset", "UTF-8");
  form.setAttribute("data-payment-redirect", "monetico");
  form.style.display = "none";
  for (const [name, value] of Object.entries(fields)) {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  return form;
}

export function submitPaymentRedirect(
  doc: Document,
  submissionUrl: string,
  fields: Record<string, string>
): void {
  const form = buildPaymentRedirectForm(doc, submissionUrl, fields);
  doc.body.appendChild(form);
  form.submit();
}
