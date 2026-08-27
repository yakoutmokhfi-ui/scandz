"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AddressSearchFn, AddressSuggestion, StructuredCustomerAddress } from "@/lib/address-types";
import {
  AddressSearchError,
  manualAddressToStructured,
  normalizeAddressSuggestion,
  searchAddressSuggestions,
} from "@/lib/services/address-search";

/**
 * FULFILLMENT ROUTING LOT B.5 / LOT ADDRESS v1 — composant
 * d'autocomplete d'adresse structurée.
 *
 * BRANCHÉ dans le parcours actif (LOT ADDRESS v1, ACTIVE CHECKOUT
 * INTEGRATION) : monté par components/FulfillmentSelector.tsx comme
 * l'UNIQUE champ actif de saisie de la rue une fois le code postal
 * structurellement valide (mission §8 -- jamais en double avec un
 * second champ `street` simultané, voir renderDeliveryAddress()).
 *
 * N'appelle JAMAIS `resolveDeliveryFulfillment` ni aucune logique de
 * routing/provider de livraison (mission §8) : ce composant produit
 * uniquement un `StructuredCustomerAddress` (lib/address-types.ts) via
 * `onChange`, plus le texte brut tapé (non encore sélectionné) via
 * `onQueryChange` -- rien d'autre.
 *
 * Auto-suffisant en libellés par défaut (aucune dépendance obligatoire
 * à lib/i18n.ts) : l'appelant réel (FulfillmentSelector.tsx) fournit
 * ses propres libellés traduits via la prop `labels`.
 */

export interface AddressAutocompleteLabels {
  inputLabel: string;
  placeholder: string;
  loading: string;
  noResults: string;
  errorMessage: string;
  manualFallbackPrompt: string;
  switchToManual: string;
  switchToSearch: string;
  clear: string;
  manualAddressLine: string;
  manualPostalCode: string;
  manualCity: string;
  manualCountryCode: string;
}

const DEFAULT_LABELS: AddressAutocompleteLabels = {
  inputLabel: "Adresse",
  placeholder: "Commencez à taper une adresse…",
  loading: "Recherche en cours…",
  noResults: "Aucune adresse trouvée",
  errorMessage: "Recherche d'adresse indisponible pour le moment.",
  manualFallbackPrompt: "Vous pouvez saisir l'adresse manuellement.",
  switchToManual: "Saisir l'adresse manuellement",
  switchToSearch: "Revenir à la recherche",
  clear: "Effacer",
  manualAddressLine: "Adresse (numéro et rue)",
  manualPostalCode: "Code postal",
  manualCity: "Ville",
  manualCountryCode: "Pays (code, ex. FR)",
};

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "results"; suggestions: AddressSuggestion[] }
  | { kind: "no-results" }
  | { kind: "error" };

export interface AddressAutocompleteProps {
  /** Adresse structurée actuellement retenue, ou `null` si aucune saisie/sélection. */
  value: StructuredCustomerAddress | null;
  onChange: (address: StructuredCustomerAddress | null) => void;
  /** Injectable pour les tests / pour changer de provider sans toucher ce composant (mission §5/§6). Défaut : searchAddressSuggestions (provider France, voir lib/services/address-search.ts). */
  search?: AddressSearchFn;
  /** Ms avant déclenchement de la recherche après la dernière frappe (LOT ADDRESS v1 §4 : 350ms, décision CIO). */
  debounceMs?: number;
  /** Longueur minimale de requête avant recherche (LOT ADDRESS v1 §3 : 6 caractères, décision CIO -- volontairement PAS 10, pour ne pas bloquer une adresse française légitime courte). */
  minQueryLength?: number;
  /**
   * LOT ADDRESS v1 (§5, "query context") — code postal déjà résolu par
   * l'étape 1 (Ville / Code postal) de l'UX en deux étapes, transmis
   * tel quel au `search` injecté (voir lib/address-types.ts,
   * AddressSearchOptions.postcode). Optionnel : ce composant reste
   * utilisable seul, sans contexte géographique préalable (l'appelant
   * qui a besoin du gate "zéro appel sans contexte" -- mission §4 --
   * ne monte simplement ce composant qu'une fois ce contexte résolu,
   * voir components/FulfillmentSelector.tsx).
   */
  postcodeContext?: string;
  /**
   * LOT ADDRESS v1 (§11/§12, "manual fallback must remain simple") —
   * appelé avec le texte brut saisi à CHAQUE frappe en mode recherche
   * (et avec `""` lors d'un effacement), indépendamment de `onChange`
   * (qui ne notifie l'appelant que sur `null` ou une sélection IGN
   * confirmée). Permet à l'appelant (FulfillmentSelector.tsx) de garder
   * la rue tapée comme valeur vivante même SANS sélection formelle --
   * le texte tapé reste utilisable tel quel comme adresse manuelle,
   * jamais bloqué derrière un mode séparé (mission §11/§12).
   */
  onQueryChange?: (text: string) => void;
  labels?: Partial<AddressAutocompleteLabels>;
  id?: string;
}

export default function AddressAutocomplete({
  value,
  onChange,
  search = searchAddressSuggestions,
  debounceMs = 350,
  minQueryLength = 6,
  postcodeContext,
  onQueryChange,
  labels: labelsOverride,
  id,
}: AddressAutocompleteProps) {
  const labels = { ...DEFAULT_LABELS, ...labelsOverride };
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const inputId = `${baseId}-address-input`;
  const listboxId = `${baseId}-address-listbox`;

  const [mode, setMode] = useState<"search" | "manual">("search");
  const [query, setQuery] = useState(value?.label ?? value?.addressLine ?? "");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [activeIndex, setActiveIndex] = useState(-1);
  const [manualDraft, setManualDraft] = useState({
    addressLine: value?.addressLine ?? "",
    postalCode: value?.postalCode ?? "",
    city: value?.city ?? "",
    countryCode: value?.countryCode ?? "FR",
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // LOT ADDRESS v1 (§12) : "no duplicate request for identical
  // normalized query" -- mémorise la clé (requête + contexte postal)
  // de la DERNIÈRE recherche réellement déclenchée (après debounce),
  // pour ignorer un nouveau passage de cet effet qui aboutirait à
  // exactement la même requête réseau (ex. un re-rendu du parent qui
  // ne change ni le texte saisi ni le contexte postal). Réinitialisée
  // dès que la requête repasse sous minQueryLength, pour ne jamais
  // bloquer une resaisie légitime ultérieure de la même valeur.
  const lastFiredKeyRef = useRef<string | null>(null);
  // FIX ADDR-V1-04 (Production, HIGH -- "SELECTED SUGGESTION REOPENS
  // AUTOCOMPLETE RESULTS") : `query` change aussi pour des raisons
  // PUREMENT PROGRAMMATIQUES -- `selectSuggestion()` appelle
  // `setQuery(suggestion.label)` après une sélection, et la valeur
  // initiale de `query` (ci-dessus) peut déjà être non vide si `value`
  // est fourni pré-rempli par l'appelant (voir
  // components/FulfillmentSelector.tsx). Sans garde, CHACUN de ces deux
  // cas relance l'effet de recherche ci-dessous (dépendance `query`),
  // qui rouvre la liste de suggestions juste après que le client vient
  // de la fermer en sélectionnant -- exactement le bug observé en
  // Production. `true` au montage (une valeur initiale pré-remplie
  // n'est jamais une frappe réelle) ; mis à `true` par
  // `selectSuggestion`/`clearSelection` (changement programmatique) ;
  // remis à `false` UNIQUEMENT par le vrai gestionnaire `onChange` du
  // champ de saisie (seule source de frappe utilisateur réelle) --
  // consommé (remis à `false`) dès le premier passage de l'effet qui
  // suit, pour ne jamais bloquer une frappe réelle ultérieure.
  const skipNextSearchRef = useRef(true);

  // Recherche débouncée -- annule la requête précédente (nouvelle
  // frappe ou démontage) via AbortController, jamais de mise à jour
  // d'état après une réponse devenue obsolète ou après démontage.
  useEffect(() => {
    if (mode !== "search") return;
    if (skipNextSearchRef.current) {
      // Ce changement de `query` est programmatique (sélection,
      // effacement, ou valeur initiale pré-remplie) -- jamais une
      // frappe réelle : aucune recherche, aucune réouverture de la
      // liste (FIX ADDR-V1-04). Consommé immédiatement : la frappe
      // réelle SUIVANTE redéclenchera normalement l'effet.
      skipNextSearchRef.current = false;
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < minQueryLength) {
      setState({ kind: "idle" });
      lastFiredKeyRef.current = null;
      return;
    }

    const dedupeKey = `${trimmed} ${postcodeContext ?? ""}`;
    if (dedupeKey === lastFiredKeyRef.current) {
      // Requête normalisée identique à la dernière déjà déclenchée --
      // aucun nouvel appel réseau (mission §12).
      return;
    }

    let cancelled = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      lastFiredKeyRef.current = dedupeKey;
      setState({ kind: "loading" });
      search(trimmed, { signal: controller.signal, postcode: postcodeContext })
        .then((suggestions) => {
          if (cancelled) return;
          setActiveIndex(-1);
          setState(suggestions.length > 0 ? { kind: "results", suggestions } : { kind: "no-results" });
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          // AddressSearchError (provider indisponible/malformé/timeout)
          // ET toute autre erreur inattendue aboutissent au même état
          // "error" -- fail-soft : ne bloque jamais la saisie, propose
          // le repli manuel (mission §10), sans jamais planter.
          void err; // AddressSearchError.reason disponible si un futur appelant veut le distinguer -- pas utilisé pour l'instant, aucune branche silencieuse cachée.
          setState({ kind: "error" });
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, mode, search, debounceMs, minQueryLength, postcodeContext]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function selectSuggestion(suggestion: AddressSuggestion) {
    const structured = normalizeAddressSuggestion(suggestion);
    // FIX ADDR-V1-04 : `setQuery` ci-dessous est un changement
    // PROGRAMMATIQUE (une sélection, jamais une frappe) -- sans ce
    // drapeau, l'effet de recherche se redéclenche avec le libellé
    // choisi comme requête et rouvre la liste de suggestions juste
    // après que l'utilisateur l'a fermée en sélectionnant.
    skipNextSearchRef.current = true;
    setQuery(suggestion.label);
    setState({ kind: "idle" });
    setActiveIndex(-1);
    onChange(structured);
  }

  function clearSelection() {
    // Changement programmatique également (voir FIX ADDR-V1-04) --
    // sans incidence pratique ici (query devient vide, sous
    // minQueryLength de toute façon), posé par cohérence/robustesse.
    skipNextSearchRef.current = true;
    setQuery("");
    setState({ kind: "idle" });
    setActiveIndex(-1);
    onChange(null);
    onQueryChange?.("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (state.kind !== "results") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, state.suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < state.suggestions.length) {
        e.preventDefault();
        selectSuggestion(state.suggestions[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setState({ kind: "idle" });
      setActiveIndex(-1);
    }
  }

  function updateManual(patch: Partial<typeof manualDraft>) {
    const next = { ...manualDraft, ...patch };
    setManualDraft(next);
    onChange(manualAddressToStructured(next));
  }

  if (mode === "manual") {
    return (
      <div className="space-y-3" data-testid="address-manual-form">
        <div>
          <label htmlFor={`${baseId}-manual-street`} className="block text-xs font-semibold text-ink-on-bg-muted">
            {labels.manualAddressLine}
          </label>
          <input
            id={`${baseId}-manual-street`}
            type="text"
            value={manualDraft.addressLine}
            onChange={(e) => updateManual({ addressLine: e.target.value })}
            className="mt-1 w-full rounded-xl border border-espresso/15 bg-white p-3 text-base text-stone-900 outline-none focus:border-caramel sm:text-sm"
          />
        </div>
        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <div>
            <label htmlFor={`${baseId}-manual-postal`} className="block text-xs font-semibold text-ink-on-bg-muted">
              {labels.manualPostalCode}
            </label>
            <input
              id={`${baseId}-manual-postal`}
              type="text"
              value={manualDraft.postalCode}
              onChange={(e) => updateManual({ postalCode: e.target.value })}
              className="mt-1 w-full rounded-xl border border-espresso/15 bg-white p-3 text-base text-stone-900 outline-none focus:border-caramel sm:text-sm"
            />
          </div>
          <div>
            <label htmlFor={`${baseId}-manual-city`} className="block text-xs font-semibold text-ink-on-bg-muted">
              {labels.manualCity}
            </label>
            <input
              id={`${baseId}-manual-city`}
              type="text"
              value={manualDraft.city}
              onChange={(e) => updateManual({ city: e.target.value })}
              className="mt-1 w-full rounded-xl border border-espresso/15 bg-white p-3 text-base text-stone-900 outline-none focus:border-caramel sm:text-sm"
            />
          </div>
        </div>
        <div>
          <label htmlFor={`${baseId}-manual-country`} className="block text-xs font-semibold text-ink-on-bg-muted">
            {labels.manualCountryCode}
          </label>
          <input
            id={`${baseId}-manual-country`}
            type="text"
            value={manualDraft.countryCode}
            onChange={(e) => updateManual({ countryCode: e.target.value })}
            maxLength={2}
            className="mt-1 w-24 rounded-xl border border-espresso/15 bg-white p-3 text-base uppercase text-stone-900 outline-none focus:border-caramel sm:text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => setMode("search")}
          className="text-xs font-semibold text-caramel underline"
        >
          {labels.switchToSearch}
        </button>
      </div>
    );
  }

  return (
    <div className="relative space-y-2" data-testid="address-autocomplete">
      <label htmlFor={inputId} className="block text-xs font-semibold text-ink-on-bg-muted">
        {labels.inputLabel}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          role="combobox"
          aria-expanded={state.kind === "results"}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            state.kind === "results" && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          type="text"
          value={query}
          placeholder={labels.placeholder}
          onChange={(e) => {
            const next = e.target.value;
            // FIX ADDR-V1-04 : ceci est la SEULE source de frappe
            // utilisateur réelle -- lève explicitement le drapeau pour
            // que l'effet de recherche s'exécute normalement (une
            // vraie frappe DOIT relancer la recherche).
            skipNextSearchRef.current = false;
            setQuery(next);
            if (value) onChange(null);
            onQueryChange?.(next);
          }}
          onKeyDown={handleKeyDown}
          className="mt-1 w-full rounded-xl border border-espresso/15 bg-white p-3 text-base text-stone-900 placeholder:text-stone-500 outline-none focus:border-caramel sm:text-sm"
        />
        {(query !== "" || value) && (
          <button type="button" onClick={clearSelection} className="mt-1 shrink-0 text-xs font-semibold text-ink-on-bg-muted underline">
            {labels.clear}
          </button>
        )}
      </div>

      {state.kind === "loading" && (
        <p role="status" aria-live="polite" className="text-xs text-ink-on-bg-muted">
          {labels.loading}
        </p>
      )}

      {state.kind === "no-results" && (
        <p role="status" aria-live="polite" className="text-xs text-ink-on-bg-muted">
          {labels.noResults}
        </p>
      )}

      {state.kind === "error" && (
        <div role="alert" className="space-y-1 text-xs text-amber-700">
          <p>{labels.errorMessage}</p>
          <p>{labels.manualFallbackPrompt}</p>
        </div>
      )}

      {state.kind === "results" && (
        // CORRIGÉ EN LOT B.5.1 (audit Work, B5-01/MEDIUM) : ce fond
        // `bg-white` est LITTÉRAL et FIXE, jamais recalculé par thème
        // -- exactement le même défaut déjà corrigé ailleurs dans le
        // repo pour InlineOptions.tsx/PastryModal.tsx/QuantityControl.tsx
        // (voir tests/ui-contrast-fix.test.ts, "UIFIX-V5" : une surface
        // blanche figée ne doit JAMAIS s'appuyer sur `text-ink-on-bg`
        // hérité du <body>, car cette couleur est CALCULÉE contre
        // `--sc-bg` -- le fond de PAGE personnalisable du marchand, pas
        // contre cette boîte blanche -- sur un thème sombre
        // (`--sc-bg` très sombre), `--sc-ink-on-bg` devient blanc :
        // texte blanc hérité sur cette boîte `bg-white` -> invisible).
        // `text-stone-900` est la couleur fixe déjà utilisée par
        // convention dans TOUT le repo pour une surface `bg-white`
        // littérale (CartPanel.tsx, FulfillmentSelector.tsx,
        // InlineOptions.tsx, MenuItemCard.tsx, OptionModal.tsx,
        // PastryModal.tsx, QuantityControl.tsx -- aucune nouvelle
        // couleur introduite ici).
        <ul id={listboxId} role="listbox" aria-label={labels.inputLabel} className="max-w-full divide-y divide-espresso/10 rounded-xl border border-espresso/15 bg-white text-stone-900">
          {state.suggestions.map((s, i) => (
            <li
              key={s.id}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(s);
              }}
              // `text-stone-900` explicite ICI AUSSI (pas seulement sur
              // la liste UL parente) : la preuve de contraste doit porter
              // sur l'élément qui affiche RÉELLEMENT le texte (`{s.label}`),
              // jamais seulement sur un ancêtre -- même exigence que
              // B5-02/tests/v100-b51-address-autocomplete-contrast.test.ts ci-dessous.
              //
              // Fond de l'option ACTIVE : `bg-crema/40` (retiré ici)
              // était calculé à partir de `--sc-bg`, la couleur de
              // fond de PAGE personnalisable du marchand -- donc, comme
              // le fond blanc lui-même, potentiellement très sombre à
              // 40% d'opacité selon le thème choisi, ce qui aurait pu
              // faire chuter le contraste de `text-stone-900` sous le
              // seuil WCAG selon la couleur choisie par le marchand.
              // `bg-stone-100` est une couleur FIXE (jamais dérivée
              // d'aucune variable de thème `--sc-*`) : contraste avec
              // `text-stone-900` garanti constant quel que soit le
              // thème du marchand (16,03:1, voir
              // tests/v100-b51-address-autocomplete-contrast.test.ts).
              className={"cursor-pointer px-3 py-2 text-sm text-stone-900 " + (i === activeIndex ? "bg-stone-100" : "")}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setMode("manual")}
        className="text-xs font-semibold text-caramel underline"
      >
        {labels.switchToManual}
      </button>
    </div>
  );
}
