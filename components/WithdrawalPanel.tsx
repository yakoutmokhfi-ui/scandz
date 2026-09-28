"use client";

import { useMemo, useRef, useState } from "react";
import { translate, type Lang } from "@/lib/i18n";

/**
 * SCANYM — ONLINE WITHDRAWAL v1 — parcours client de rétractation.
 *
 * Trois étapes STRICTEMENT séparées (art. L221-21 / D.221-5, et
 * addendum UX §E) :
 *
 *   1. SÉLECTION  — produits éligibles UNIQUEMENT, quantité partielle
 *                   possible. Aucune écriture.
 *   2. RÉCAPITULATIF — identité (nom, prénom) et moyen électronique de
 *                   réception de l'accusé, rappel EXACT des produits et
 *                   quantités demandés. Aucune écriture.
 *   3. CONFIRMATION EXPLICITE — « Confirmer la rétractation » : seule
 *                   action qui écrit, via /track/{orderId}/withdrawal.
 *
 * Ce composant ne décide JAMAIS de l'éligibilité : il affiche les
 * lignes que le serveur a déclarées éligibles à partir de l'instantané
 * immuable de la commande, et n'envoie que des identifiants de ligne et
 * des quantités.
 *
 * LOT 1 (P0, cookie-path fix) : ce point de terminaison vivait
 * auparavant sous app/api/track/withdrawal/route.ts. Le cookie de
 * session de suivi (`st_session`, lib/server/tracking-session.ts) est
 * volontairement scopé à `path: /track/{orderId}` -- un chemin sous
 * `/api/track/...` n'est JAMAIS un sous-chemin de `/track/{orderId}`
 * (RFC 6265 §5.1.4), donc le navigateur ne l'envoyait jamais à cette
 * route : la confirmation échouait systématiquement avec
 * WITHDRAWAL_CAPABILITY_INVALID, quelle que soit la validité réelle de
 * la capacité. Correctif structurel : la route vit maintenant sous
 * `/track/{orderId}/withdrawal`, un sous-chemin réel de la portée du
 * cookie -- aucun changement du modèle d'autorisation lui-même
 * (verifyTrackingSessionToken + liaison orderId, inchangés).
 *
 * LOT 2 (P1, quantité + contraste) : correctifs UX ciblés (issue #11,
 * mandat CIO/Ravel #5873108024, points 4/5/8), sans changement au
 * modèle de données ni à l'autorité serveur (déjà exercée par la RPC
 * submit_withdrawal_request_by_capability, WITHDRAWAL_QUANTITY_EXCEEDS_ORDERED
 * déjà en vigueur -- point 7 du mandat déjà satisfait, aucun code
 * serveur touché par ce lot) :
 *   - une ligne dont remainingQuantity === 1 n'affiche plus AUCUN
 *     sélecteur de quantité -- cocher la ligne signifie 1/1 (point 4) ;
 *   - le champ de quantité (remainingQuantity > 1) ne se désactive plus
 *     lui-même en cours de frappe : voir `quantityDrafts` et
 *     handleQuantityInput/commitQuantityDraft ci-dessous pour le
 *     mécanisme -- un état de saisie INTERMÉDIAIRE (champ vidé pour
 *     retaper, valeur momentanément non numérique) ne touche JAMAIS la
 *     quantité RETENUE (`quantities`), donc ne peut plus désactiver le
 *     champ en cours de frappe (point 5). La règle métier approuvée
 *     (mandat #5873108024, littéral : « 0 = unselected ») reste
 *     inchangée : une valeur numérique VALIDÉE (commitée) à 0
 *     désélectionne bien la ligne, exactement comme décocher la case --
 *     REMÉDIATION (audit Chateaubriand/Ravel, commentaires 5876097341/
 *     5876134468) : une version antérieure de ce lot avait par erreur
 *     remonté le plancher de clamp de 0 à 1, empêchant `0` tapé et
 *     validé de désélectionner une ligne. Corrigé ici -- le plancher
 *     redevient 0, uniquement pour la valeur RETENUE (jamais pour un
 *     état de saisie intermédiaire, qui ne passe jamais par ce chemin) ;
 *   - les boutons secondaires « Retour » (sélection et récapitulatif)
 *     portent désormais `text-ink-on-bg` explicitement, comme le
 *     bouton d'entrée déjà correct plus haut dans ce même fichier --
 *     jusqu'ici ils héritaient une couleur de texte non garantie,
 *     illisible sur certains thèmes sombres personnalisés par le
 *     commerçant (même défaut de fond, même classe de correction, que
 *     UIFIX-01 déjà appliqué à CategoryNav.tsx) (point 8).
 * Le point 6 (récapitulatif = quantités exactes) et le point 7
 * (autorité serveur) étaient déjà satisfaits avant ce lot -- vérifiés,
 * non modifiés.
 */

export interface WithdrawalPanelOption {
  orderItemId: string;
  itemName: string;
  optionName: string | null;
  orderedQuantity: number;
  remainingQuantity: number;
}

type Step = "closed" | "selection" | "review" | "done";

interface Receipt {
  withdrawalRequestId: string;
  requestedAt: string;
  acknowledgementStatus: string;
}

function uuidV4(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  // Repli déterministe-suffisant pour l'idempotence (jamais une source
  // de sécurité : la sécurité vient de la capacité de suivi).
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function WithdrawalPanel({
  orderId,
  orderNumber,
  options,
  lang,
}: {
  orderId: string;
  orderNumber: number;
  options: WithdrawalPanelOption[];
  lang: Lang;
}) {
  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars);

  const [step, setStep] = useState<Step>("closed");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  // LOT 2 -- QUANTITÉ UX. Tampon de SAISIE BRUTE, distinct de
  // `quantities` (la quantité RETENUE, seule source pour `checked`,
  // `disabled` et l'envoi). Sans ce tampon, vider le champ pour
  // retaper une nouvelle valeur passait par un état intermédiaire
  // quantité=0 -- qui désactivait le champ (disabled={quantity===0})
  // AVANT que l'utilisateur ait pu taper le chiffre suivant, le
  // bloquant en plein milieu de sa saisie. Un champ vidé (chaîne vide)
  // ou momentanément non numérique reste ici SANS toucher à la
  // quantité retenue -- voir handleQuantityInput/commitQuantityDraft.
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [ackAddress, setAckAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  // Idempotence : un identifiant par déclaration, stable tant que la
  // même déclaration est en cours -- un double clic ou un renvoi après
  // panne réseau ne crée jamais deux demandes.
  const clientRequestId = useRef<string>(uuidV4());
  const submitGuard = useRef(false);

  const selected = useMemo(
    () =>
      options
        .map((option) => ({ option, quantity: quantities[option.orderItemId] ?? 0 }))
        .filter((entry) => entry.quantity > 0),
    [options, quantities]
  );

  function toggle(option: WithdrawalPanelOption, checked: boolean) {
    setErrorCode(null);
    setQuantities((prev) => ({ ...prev, [option.orderItemId]: checked ? 1 : 0 }));
    clearQuantityDraft(option);
  }

  // LOT 2 -- QUANTITÉ UX (point 4/5 du mandat CIO/Ravel, issue #11
  // #5873108024). RÈGLE APPROUVÉE (mandat, littéral) : « Quantity>1:
  // customer can choose integer 1..ordered quantity; 0 = unselected. »
  // Plancher à 0 (jamais 1 -- voir REMÉDIATION dans l'en-tête de ce
  // fichier) : une valeur numérique VALIDÉE (commitée depuis
  // handleQuantityInput, donc jamais depuis un état de saisie
  // intermédiaire, cf. quantityDrafts) à 0 désélectionne la ligne,
  // exactement comme décocher la case -- `checked`/`disabled` en
  // dérivent directement (checked={quantity > 0}), donc aucun état
  // supplémentaire à synchroniser ici.
  function setQuantity(option: WithdrawalPanelOption, value: number) {
    const clamped = Math.max(0, Math.min(option.remainingQuantity, Math.trunc(value)));
    setQuantities((prev) => ({ ...prev, [option.orderItemId]: clamped }));
  }

  function clearQuantityDraft(option: WithdrawalPanelOption) {
    setQuantityDrafts((prev) => {
      if (!(option.orderItemId in prev)) return prev;
      const next = { ...prev };
      delete next[option.orderItemId];
      return next;
    });
  }

  /**
   * Appelé à CHAQUE frappe dans le champ de quantité (uniquement rendu
   * quand remainingQuantity > 1, voir le rendu plus bas).
   *
   * Chaîne vide ou non numérique : affichée telle quelle (l'utilisateur
   * est en train de composer une nouvelle valeur) -- SANS jamais
   * toucher à `quantities`, donc sans jamais désactiver le champ ni
   * décocher la ligne pendant la frappe.
   *
   * Valeur numérique valide : commit immédiat dans `quantities`
   * (bornée par setQuantity), et le tampon brut est effacé -- le champ
   * affiche alors directement la quantité RETENUE (bornée), jamais une
   * saisie non validée qui dépasserait le stock restant.
   */
  function handleQuantityInput(option: WithdrawalPanelOption, raw: string) {
    if (raw.trim() === "" || !Number.isFinite(Number(raw))) {
      setQuantityDrafts((prev) => ({ ...prev, [option.orderItemId]: raw }));
      return;
    }
    setQuantity(option, Number(raw));
    clearQuantityDraft(option);
  }

  /**
   * Au blur : abandonne toute saisie brute non commitée (ex. champ
   * laissé vide sans nombre valide) -- l'affichage revient alors à la
   * quantité réellement retenue, jamais un champ vide/incohérent.
   */
  function commitQuantityDraft(option: WithdrawalPanelOption) {
    clearQuantityDraft(option);
  }

  async function confirm() {
    if (submitGuard.current || submitting) return;
    submitGuard.current = true;
    setSubmitting(true);
    setErrorCode(null);
    try {
      const response = await fetch(`/track/${orderId}/withdrawal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId,
          firstName,
          lastName,
          acknowledgementAddress: ackAddress,
          clientRequestId: clientRequestId.current,
          items: selected.map((entry) => ({
            orderItemId: entry.option.orderItemId,
            quantity: entry.quantity,
          })),
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        code?: string;
        withdrawalRequestId?: string;
        requestedAt?: string;
        acknowledgementStatus?: string;
      };
      if (!response.ok || !payload.ok) {
        setErrorCode(payload.code ?? "WITHDRAWAL_UNAVAILABLE");
        return;
      }
      setReceipt({
        withdrawalRequestId: payload.withdrawalRequestId!,
        requestedAt: payload.requestedAt!,
        acknowledgementStatus: payload.acknowledgementStatus ?? "pending",
      });
      setStep("done");
    } catch {
      setErrorCode("WITHDRAWAL_UNAVAILABLE");
    } finally {
      setSubmitting(false);
      submitGuard.current = false;
    }
  }

  // Aucune ligne éligible -> le composant n'est jamais monté par la
  // page (voir app/track/[orderId]/page.tsx). Garde défensive.
  if (options.length === 0) return null;

  if (step === "closed") {
    return (
      <section className="mt-6 rounded-2xl border border-ink-on-bg/15 p-4">
        <p className="text-sm text-ink-on-bg-muted">{t("withdrawalEntryHelp")}</p>
        <button
          type="button"
          data-withdrawal-action="open"
          onClick={() => setStep("selection")}
          className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-ink-on-bg/30 px-4 py-2 text-sm font-bold text-ink-on-bg underline-offset-2"
        >
          {t("withdrawalEntryAction")}
        </button>
      </section>
    );
  }

  if (step === "selection") {
    return (
      <section className="mt-6 rounded-2xl border border-ink-on-bg/15 p-4" data-withdrawal-step="selection">
        <h2 className="text-lg font-bold text-ink-on-bg">{t("withdrawalEntryAction")}</h2>
        <p className="mt-1 text-sm text-ink-on-bg-muted">{t("withdrawalOrderRef", { n: orderNumber })}</p>
        <p className="mt-2 text-sm text-ink-on-bg-muted">{t("withdrawalSelectionHelp")}</p>

        <ul className="mt-4 space-y-3">
          {options.map((option) => {
            const quantity = quantities[option.orderItemId] ?? 0;
            return (
              <li key={option.orderItemId} data-withdrawal-line={option.orderItemId}>
                <label className="flex items-start gap-3 text-sm text-ink-on-bg">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={quantity > 0}
                    onChange={(event) => toggle(option, event.target.checked)}
                  />
                  <span className="flex-1">
                    <span className="font-semibold">{option.itemName}</span>
                    {option.optionName ? (
                      <span className="block text-ink-on-bg-muted">+ {option.optionName}</span>
                    ) : null}
                    {/* LOT 2 -- QUANTITÉ UX (point 4 du mandat) : une ligne
                        dont il ne reste qu'une seule unité rétractable
                        n'offre AUCUN choix de quantité -- la case cochée
                        signifie 1/1, sans sélecteur numérique redondant
                        ("/ 1" n'apportait aucune information). Rendu
                        strictement identique au comportement historique
                        dès que remainingQuantity > 1. */}
                    {option.remainingQuantity > 1 ? (
                      <span className="mt-1 flex items-center gap-2">
                        <span className="text-ink-on-bg-muted">{t("withdrawalQuantityLabel")}</span>
                        <input
                          type="number"
                          min={1}
                          max={option.remainingQuantity}
                          value={quantityDrafts[option.orderItemId] ?? String(quantity > 0 ? quantity : 1)}
                          disabled={quantity === 0}
                          data-withdrawal-quantity={option.orderItemId}
                          onChange={(event) => handleQuantityInput(option, event.target.value)}
                          onBlur={() => commitQuantityDraft(option)}
                          className="w-16 rounded-lg border border-ink-on-bg/30 px-2 py-1"
                        />
                        <span className="text-ink-on-bg-muted">
                          / {option.remainingQuantity}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setStep("closed")}
            className="min-h-11 rounded-xl border border-ink-on-bg/30 px-4 py-2 text-sm font-semibold text-ink-on-bg"
          >
            {t("withdrawalBack")}
          </button>
          <button
            type="button"
            data-withdrawal-action="continue"
            disabled={selected.length === 0}
            onClick={() => setStep("review")}
            className="min-h-11 rounded-xl bg-ink-on-bg px-4 py-2 text-sm font-bold text-bg disabled:opacity-40"
          >
            {t("withdrawalContinue")}
          </button>
        </div>
      </section>
    );
  }

  if (step === "review") {
    const canConfirm =
      selected.length > 0 && firstName.trim() !== "" && lastName.trim() !== "" && ackAddress.includes("@");
    return (
      <section className="mt-6 rounded-2xl border border-ink-on-bg/15 p-4" data-withdrawal-step="review">
        <h2 className="text-lg font-bold text-ink-on-bg">{t("withdrawalReviewTitle")}</h2>
        <p className="mt-1 text-sm text-ink-on-bg-muted">{t("withdrawalOrderRef", { n: orderNumber })}</p>

        <ul className="mt-3 space-y-1 text-sm text-ink-on-bg">
          {selected.map(({ option, quantity }) => (
            <li key={option.orderItemId} data-withdrawal-review-line={option.orderItemId}>
              {quantity} × {option.itemName}
              {option.optionName ? ` (${option.optionName})` : ""}
            </li>
          ))}
        </ul>

        {/* D.221-5 : le consommateur fournit ou confirme ses nom et
            prénom, et le moyen électronique par lequel il souhaite
            recevoir l'accusé de réception. */}
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="text-ink-on-bg-muted">{t("withdrawalFirstNameLabel")}</span>
            <input
              type="text"
              value={firstName}
              data-withdrawal-field="firstName"
              onChange={(event) => setFirstName(event.target.value)}
              className="mt-1 w-full rounded-xl border border-ink-on-bg/30 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-on-bg-muted">{t("withdrawalLastNameLabel")}</span>
            <input
              type="text"
              value={lastName}
              data-withdrawal-field="lastName"
              onChange={(event) => setLastName(event.target.value)}
              className="mt-1 w-full rounded-xl border border-ink-on-bg/30 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-ink-on-bg-muted">{t("withdrawalAckAddressLabel")}</span>
            <input
              type="email"
              inputMode="email"
              value={ackAddress}
              data-withdrawal-field="ackAddress"
              onChange={(event) => setAckAddress(event.target.value)}
              className="mt-1 w-full rounded-xl border border-ink-on-bg/30 px-3 py-2"
            />
            <span className="mt-1 block text-xs text-ink-on-bg-muted">{t("withdrawalAckAddressHelp")}</span>
          </label>
        </div>

        {errorCode ? (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-withdrawal-error={errorCode}>
            {t(`withdrawalError_${errorCode}`) !== `withdrawalError_${errorCode}`
              ? t(`withdrawalError_${errorCode}`)
              : t("withdrawalError_WITHDRAWAL_UNAVAILABLE")}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setStep("selection")}
            className="min-h-11 rounded-xl border border-ink-on-bg/30 px-4 py-2 text-sm font-semibold text-ink-on-bg"
          >
            {t("withdrawalBack")}
          </button>
          <button
            type="button"
            data-withdrawal-action="confirm"
            disabled={!canConfirm || submitting}
            aria-busy={submitting}
            onClick={() => void confirm()}
            className="min-h-11 rounded-xl bg-ink-on-bg px-4 py-2 text-sm font-bold text-bg disabled:opacity-40"
          >
            {submitting ? t("withdrawalSubmitting") : t("withdrawalConfirmAction")}
          </button>
        </div>
      </section>
    );
  }

  // step === "done"
  const requestedAt = receipt ? new Date(receipt.requestedAt) : null;
  return (
    <section className="mt-6 rounded-2xl border border-ink-on-bg/15 p-4" data-withdrawal-step="done">
      <h2 className="text-lg font-bold text-ink-on-bg">{t("withdrawalDoneTitle")}</h2>
      <p className="mt-1 text-sm text-ink-on-bg-muted">{t("withdrawalOrderRef", { n: orderNumber })}</p>
      {receipt ? (
        <>
          <p className="mt-1 text-sm text-ink-on-bg-muted" data-withdrawal-reference={receipt.withdrawalRequestId}>
            {t("withdrawalRequestRef", { ref: receipt.withdrawalRequestId })}
          </p>
          {requestedAt ? (
            <p className="mt-1 text-sm text-ink-on-bg-muted">
              {t("withdrawalDeclaredAt", {
                date: requestedAt.toLocaleDateString(lang === "ar" ? "ar" : lang === "en" ? "en-GB" : "fr-FR"),
                time: requestedAt.toLocaleTimeString(lang === "ar" ? "ar" : lang === "en" ? "en-GB" : "fr-FR", {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </p>
          ) : null}
          <ul className="mt-3 space-y-1 text-sm text-ink-on-bg">
            {selected.map(({ option, quantity }) => (
              <li key={option.orderItemId}>
                {quantity} × {option.itemName}
              </li>
            ))}
          </ul>
          {/* Statut RÉEL de l'accusé de réception : jamais « envoyé »
              tant qu'un prestataire d'envoi ne l'a pas confirmé. */}
          <p
            className="mt-3 rounded-xl bg-stone-50 p-3 text-sm text-ink-on-bg-muted"
            data-withdrawal-ack={receipt.acknowledgementStatus}
          >
            {receipt.acknowledgementStatus === "sent"
              ? t("withdrawalAckSent")
              : receipt.acknowledgementStatus === "unavailable_no_channel"
                ? t("withdrawalAckUnavailable")
                : t("withdrawalAckPending")}
          </p>
        </>
      ) : null}
    </section>
  );
}
