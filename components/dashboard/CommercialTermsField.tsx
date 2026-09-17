"use client";

import { useState } from "react";

/**
 * STANDARD COMMERCIAL TERMS UX v1.
 *
 * Prédicat "le marchand a-t-il un texte personnalisé ?", RECOPIÉ
 * VOLONTAIREMENT du moteur de rendu (lib/legal/render.ts, sections
 * annulation/substitution : `!!text && text.trim() !== ""`). L'UI et
 * le rendu DOIVENT trancher identiquement, sinon le marchand pourrait
 * voir "personnalisé" alors que ses CGV publient le texte standard (ou
 * l'inverse) -- un mensonge d'interface sur un document juridique. Un
 * texte composé uniquement d'espaces compte donc comme STANDARD, des
 * deux côtés.
 */
export function isCustomCommercialTerms(text: string | null | undefined): boolean {
  return !!text && text.trim() !== "";
}

/**
 * STANDARD COMMERCIAL TERMS UX v1.1 -- clôture de
 * CGV-UX-V1-PERSONALISE-STATE-01.
 *
 * Traduit un BROUILLON d'éditeur (état d'interface, éphémère) en
 * VALEUR MÉTIER à persister (colonne *_policy_text du profil).
 *
 * Deux brouillons ne créent JAMAIS d'override marchand :
 *   - un brouillon vide ou composé uniquement d'espaces -- c'est le
 *     texte standard qui publierait, donc la valeur métier est NULL,
 *     exactement comme le tranche le moteur de rendu ;
 *   - un brouillon STRICTEMENT identique au texte standard pré-rempli
 *     -- le marchand a ouvert l'éditeur sans rien personnaliser ; le
 *     convertir en override figerait une copie du gabarit dans le
 *     profil, qui cesserait alors de suivre les futures versions du
 *     texte standard. C'est précisément le défaut relevé par l'audit.
 *
 * Toute autre saisie est une personnalisation authentique et devient
 * la valeur métier.
 */
export function commitCommercialTerms(
  draft: string,
  standardText?: string
): string | null {
  if (draft.trim() === "") return null;
  if (standardText !== undefined && draft === standardText) return null;
  return draft;
}

type CommercialTermsFieldProps = {
  sectionKey: "cancellation" | "substitution";
  label: string;
  /** Texte standard, lu du gabarit CGV en vigueur -- JAMAIS codé en dur ici. */
  standardText?: string;
  value: string | null;
  onChange: (next: string | null) => void;
  canEdit: boolean;
  editing: boolean;
  onEditingChange: (open: boolean) => void;
  confirmingRestore: boolean;
  onRequestRestore: () => void;
  onCancelRestore: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
};

/**
 * Une section commerciale personnalisable, avec ses deux états
 * explicites : A. standard Scanym / B. personnalisée.
 *
 * Sémantique de stockage INCHANGÉE par ce lot : NULL/vide => standard,
 * non-vide => personnalisé. Aucune colonne d'état, aucune table, aucune
 * migration. Le badge reflète TOUJOURS ce qui sera réellement rendu
 * (isCustomCommercialTerms sur la valeur stockée) ; `editing` ne pilote
 * que l'ouverture de l'éditeur, jamais l'étiquette -- ainsi un marchand
 * qui ouvre l'éditeur sans rien saisir reste honnêtement affiché comme
 * "standard", parce que c'est bien le texte standard qui publierait.
 *
 * Le texte standard affiché provient du gabarit en vigueur
 * (cancellation_clause_fallback / substitution_clause_fallback) : quand
 * Scanym publiera une nouvelle version de gabarit via le mécanisme de
 * versionnage existant, cette UI suivra sans modification de code.
 */
export default function CommercialTermsField({
  sectionKey, label, standardText, value, onChange, canEdit,
  editing, onEditingChange, confirmingRestore, onRequestRestore, onCancelRestore, t,
}: CommercialTermsFieldProps) {
  const isCustom = isCustomCommercialTerms(value);
  const showEditor = isCustom || editing;

  // v1.1 -- BROUILLON D'ÉDITEUR, strictement local et non persisté.
  // Il n'existe que pour le cas "le marchand a ouvert l'éditeur alors
  // qu'il est encore sur le standard" : le texte standard y est
  // pré-rempli comme point de départ SANS jamais être écrit dans la
  // valeur métier. Dès qu'une valeur personnalisée existe réellement,
  // la zone de saisie redevient pilotée par `value` (source de vérité
  // persistée), et le brouillon ne fait plus que la suivre.
  const [draft, setDraft] = useState<string>(value ?? "");
  const editorText = isCustom ? value ?? "" : draft;

  return (
    <div
      className="space-y-2 rounded-xl border border-stone-200 p-3"
      data-testid={`commercial-terms-${sectionKey}`}
      data-terms-state={isCustom ? "custom" : "standard"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-stone-900">{label}</h3>
        <span
          data-testid={`commercial-terms-badge-${sectionKey}`}
          className={
            isCustom
              ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
              : "rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-700"
          }
        >
          {isCustom ? t("legalCgvTermsCustomBadge") : t("legalCgvTermsStandardBadge")}
        </span>
      </div>

      {!showEditor && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            {t("legalCgvTermsStandardPreviewLabel")}
          </p>
          <p
            data-testid={`commercial-terms-standard-text-${sectionKey}`}
            className="whitespace-pre-wrap rounded-lg bg-stone-50 p-2 text-sm text-stone-700"
          >
            {standardText ?? t("legalCgvTermsNoStandard")}
          </p>
          {canEdit && (
            <button
              type="button"
              data-testid={`commercial-terms-customise-${sectionKey}`}
              onClick={() => {
                // v1.1 -- CGV-UX-V1-PERSONALISE-STATE-01 : ouvrir
                // l'éditeur est un geste d'INTERFACE. On pré-remplit le
                // BROUILLON et rien d'autre. Aucun onChange n'est émis :
                // la valeur métier reste NULL, le badge reste
                // "standard", et l'aperçu continue de rendre le texte
                // standard tant que le marchand n'a rien personnalisé.
                setDraft(standardText ?? "");
                onEditingChange(true);
              }}
              className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-800"
            >
              {t("legalCgvTermsCustomise")}
            </button>
          )}
        </>
      )}

      {showEditor && (
        <>
          <textarea
            disabled={!canEdit}
            data-testid={`commercial-terms-textarea-${sectionKey}`}
            rows={5}
            className="w-full rounded-lg border p-2 text-sm"
            placeholder={label}
            value={editorText}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              // Seule une saisie RÉELLE crée une valeur métier ; un
              // brouillon vide, en espaces, ou resté identique au
              // texte standard retombe sur NULL (= standard).
              onChange(commitCommercialTerms(next, standardText));
            }}
          />
          {canEdit && !confirmingRestore && (
            <button
              type="button"
              data-testid={`commercial-terms-restore-${sectionKey}`}
              onClick={onRequestRestore}
              className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-800"
            >
              {t("legalCgvTermsRestore")}
            </button>
          )}
          {canEdit && confirmingRestore && (
            <div
              data-testid={`commercial-terms-restore-confirm-${sectionKey}`}
              className="space-y-2 rounded-lg bg-amber-50 p-2"
            >
              <p className="text-sm text-amber-900">{t("legalCgvTermsRestoreQuestion")}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid={`commercial-terms-restore-yes-${sectionKey}`}
                  onClick={() => {
                    onChange(null);
                    setDraft("");
                    onEditingChange(false);
                    onCancelRestore();
                  }}
                  className="rounded-xl bg-stone-900 px-3 py-1.5 text-sm font-bold text-white"
                >
                  {t("legalCgvTermsRestoreConfirm")}
                </button>
                <button
                  type="button"
                  data-testid={`commercial-terms-restore-no-${sectionKey}`}
                  onClick={onCancelRestore}
                  className="rounded-xl border border-stone-300 px-3 py-1.5 text-sm font-semibold text-stone-800"
                >
                  {t("legalCgvTermsRestoreCancel")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
