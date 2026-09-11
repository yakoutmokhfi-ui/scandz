"use client";

/**
 * Scanym — OPERATOR BACKOFFICE — OB-3/OB-4 v1.1 — CATALOGUE IMPORT.
 * Upload -> Analyse -> Preview -> Errors/Warnings -> éligibilité ->
 * Confirmation explicite -> Résultat (mandat OB-4 v1.1 : "Preview
 * approved -> explicit Confirm import -> server-side revalidation ->
 * deterministic catalogue commit -> result summary. No automatic
 * commit.").
 *
 * Le bouton de confirmation n'est JAMAIS actif tant qu'aucun Preview
 * ÉLIGIBLE (ELIGIBLE ou ELIGIBLE_WITH_WARNINGS) n'a été affiché pour LE
 * MÊME fichier -- et sa propre action ré-analyse intégralement le
 * fichier (jamais le `report` déjà affiché) : voir lib/services/
 * catalogue-import-commit.ts, "SERVER-SIDE REVALIDATION" -- un Preview
 * affiché puis un catalogue qui change avant la confirmation (import
 * concurrent, autre onglet) ne peut donc jamais produire un commit
 * incohérent avec l'état réel au moment du clic.
 *
 * TENANT ISOLATION : le restaurant cible est TOUJOURS explicite,
 * jamais implicite -- via le paramètre d'URL `?r=<restaurant_id>`
 * (même convention que app/dashboard/catalogue, seul point d'entrée
 * déjà utilisé par un opérateur Scanym aujourd'hui -- voir
 * FINDINGS.md, "Constat UI role gating"), ou via le sélecteur
 * ci-dessous. Tant qu'aucun restaurant n'est résolu, l'analyse reste
 * bloquée : "Preview must operate only on the explicitly selected
 * restaurant."
 *
 * CONTEXTE ÉTABLISSEMENT SÉLECTIONNÉ (v1.2, remédiation ciblée) --
 * BUG DE PRODUCTION CONSTATÉ ET CORRIGÉ : avant v1.2, ce fichier
 * résolvait correctement `restaurantId` depuis `?r=` MAIS peuplait le
 * SÉLECTEUR affiché depuis `getMerchantRestaurants()` (autorité
 * MARCHAND, restaurant_users) -- une source sans rapport avec `?r=`.
 * Quand le compte opérateur utilisé possédait par ailleurs une ligne
 * restaurant_users pour un AUTRE établissement que celui du cockpit
 * (ex. "Sanaa Cookies & Fondant" alors que le cockpit affichait "Au
 * lait cru"), le `<select value={restaurantId}>` ne trouvait aucune
 * `<option>` correspondant à `restaurantId` (l'établissement du
 * cockpit n'étant pas dans la liste "mes restaurants" de ce compte) --
 * le navigateur affichait alors silencieusement la première (et
 * seule) option réelle du menu, soit un établissement DIFFÉRENT de
 * celui explicitement sélectionné dans le cockpit. Root cause vérifié
 * indépendamment (jamais supposé), voir le paquet livré.
 *
 * CORRECTIF : le sélecteur utilise désormais EXCLUSIVEMENT la source
 * Admin/Opérateur déjà publiée et déjà auditée,
 * `listOperatorEstablishments()` (lib/services/operator-directory.ts,
 * OB-1 -- policy RLS "lecture operateur restaurants",
 * `is_scanym_operator()`, AUCUNE ligne restaurant_users requise,
 * AUCUNE nouvelle RPC/policy). `getMerchantRestaurants()` n'est plus
 * appelé du tout par cette page -- l'appartenance restaurant_users
 * marchande n'est plus jamais une autorité pour ce qui s'affiche ou se
 * présélectionne ici. `?r=` reste TOUJOURS la valeur par défaut
 * (jamais silencieusement remplacée par l'ordre du tableau, le
 * premier établissement, ou une appartenance restaurant_users) ; en
 * son absence, aucune présélection automatique n'a lieu -- l'Admin
 * choisit explicitement. Changer d'établissement via le sélecteur
 * invalide immédiatement tout Preview/résultat de commit déjà affiché
 * (voir handlers ci-dessous) : jamais de confirmation sur un aperçu
 * généré pour un autre établissement.
 *
 * AUTORISATION -- ADMIN ONLY (v1.1, remédiation ciblée) : l'import
 * de catalogue en masse est une règle métier ADMIN ONLY, distincte de
 * la lecture/édition unitaire du catalogue (que `get_merchant_catalogue`
 * et les RPC `create_*`/`update_*` continuent d'autoriser au
 * propriétaire/manager de son propre restaurant, sans changement --
 * ce lot ne touche NI OB-3 NI OB-4). Même idiome, réutilisé tel quel,
 * que app/admin/establishments/page.tsx, app/admin/establishments/new/
 * page.tsx et app/admin/establishments/cockpit/page.tsx :
 * authChecked/authorized + `isScanymOperator()` + redirection
 * `router.replace("/dashboard")` pour tout compte authentifié mais non
 * opérateur -- AVANT toute résolution de restaurant, tout chargement
 * de fichier, tout appel à `analyzeCatalogueImportFile`/
 * `commitCatalogueImport`. Un marchand (propriétaire de son propre
 * restaurant ou non) qui arrive ici par navigation directe -- avec ou
 * sans `?r=`, avec son propre restaurant_id ou un autre -- est
 * redirigé avant que la sélection de fichier ou les boutons
 * Analyser/Confirmer n'existent dans le DOM.
 *
 * LIMITE DOCUMENTÉE (frontière app-layer vs RPC/RLS) : comme rappelé
 * explicitement par lib/services/establishments.ts ("isScanymOperator()
 * ... sert uniquement à l'affichage (masquer/rediriger), jamais seule
 * protection"), cette redirection est un contrôle d'application (UI),
 * pas une garantie PostgreSQL. `get_merchant_catalogue` et les RPC
 * d'écriture du catalogue (create_category/create_product/etc.)
 * restent, par conception OB-2 v1.1, accessibles à la fois à
 * `is_scanym_operator()` ET au propriétaire/manager légitime de SON
 * PROPRE restaurant -- exactement ce qui permet à un marchand
 * d'éditer normalement son propre catalogue ailleurs dans l'app. Ces
 * RPC ne distinguent donc pas "édition unitaire légitime" de "import
 * en masse", et ne peuvent pas être restreintes à is_scanym_operator()
 * seul sans casser l'édition marchande normale. Une garantie
 * équivalente côté base de données (un chemin RPC dédié à l'import en
 * masse, réservé à is_scanym_operator()) nécessiterait un changement
 * SQL -- explicitement hors périmètre de ce lot (voir STOP-REPORT
 * dans le paquet livré).
 *
 * RACE ASYNCHRONE PREVIEW (v1.3, remédiation ciblée) -- INVARIANT
 * CRITIQUE : ÉTABLISSEMENT AFFICHÉ = CIBLE PREVIEW = CIBLE COMMIT.
 * `analyzeCatalogueImportFile`/`commitCatalogueImport` sont
 * asynchrones ; sans protection, une réponse Preview obsolète (partie
 * pour l'établissement A, résolue APRÈS que l'Admin a basculé vers B)
 * pouvait écraser `result` avec l'aperçu de A alors que `restaurantId`
 * valait déjà B -- gouvernant ainsi l'éligibilité de confirmation avec
 * un Preview pour un établissement différent de la cible réelle du
 * Commit. Root cause vérifié (audit Catimini) : `setResult(analysis)`
 * dans la continuation `await` de `handleAnalyze` s'exécutait
 * inconditionnellement, sans revérifier que le contexte (établissement
 * ET fichier) n'avait pas changé entre le lancement de l'analyse et sa
 * résolution.
 *
 * CORRECTIF -- jeton de génération de requête (`analyzeTokenRef`,
 * `useRef<number>`), incrémenté à CHAQUE événement qui invalide un
 * Preview en vol : nouveau clic Analyser, changement d'établissement,
 * changement de fichier. `handleAnalyze` capture le jeton courant
 * (`myToken`) ET le `restaurantId` cible AVANT l'appel asynchrone ; à
 * la résolution (succès ou erreur), la réponse n'est acceptée QUE si
 * `analyzeTokenRef.current === myToken` -- toute réponse dont le jeton
 * ne correspond plus au dernier événement de contexte est silencieusement
 * ignorée (jamais affichée, jamais éligible au commit). Ce mécanisme
 * couvre à la fois : (a) bascule d'établissement pendant un Preview en
 * vol, (b) changement de fichier pendant un Preview en vol, et (c)
 * deux clics Analyser qui se chevauchent (le plus récent gagne
 * toujours, même si l'ancien se résout après -- classique "latest
 * request wins", pas de complexité supplémentaire type AbortController
 * puisqu'aucune primitive d'annulation réseau n'existe déjà sur le
 * chemin `analyzeCatalogueImportFile`/`commitCatalogueImport`, mandat
 * "Do not introduce unnecessary complexity").
 *
 * SEUIL EXPLICITE SUPPLÉMENTAIRE (défense en profondeur, pas
 * seulement un nettoyage visuel) : `previewRestaurantId` mémorise
 * l'établissement pour lequel le Preview actuellement affiché a
 * réellement été généré. `handleConfirmCommit` refuse explicitement de
 * committer si `previewRestaurantId !== restaurantId` -- un garde-fou
 * indépendant du jeton, vérifiable par lecture directe du code,
 * jamais une simple absence-de-`result`. La revalidation serveur déjà
 * en place côté OB-4 (relecture complète du fichier ET du catalogue à
 * la confirmation, jamais le `report` déjà affiché) reste inchangée et
 * s'exécute toujours en plus de ce garde-fou côté page.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getUser } from "@/lib/services/auth";
import { isScanymOperator } from "@/lib/services/establishments";
import { listOperatorEstablishments } from "@/lib/services/operator-directory";
import type { OperatorEstablishmentListItem } from "@/lib/operator-cockpit";
import {
  analyzeCatalogueImportFile,
  type CatalogueImportAnalysisResult,
} from "@/lib/services/catalogue-import";
import {
  commitCatalogueImport,
  type CatalogueImportCommitResult,
} from "@/lib/services/catalogue-import-commit";
import type { PreviewRow } from "@/lib/catalogue-import/types";

const COMMIT_ROW_OUTCOME_LABEL: Record<string, string> = {
  CREATED: "Créé",
  UPDATED: "Mis à jour",
  SKIPPED: "Sans changement",
  FAILED: "Échec",
};

const STATUS_LABEL: Record<PreviewRow["status"], string> = {
  OK: "OK",
  WARNING: "Avertissement",
  BLOCKED: "Bloqué",
};

const ACTION_LABEL: Record<PreviewRow["plannedAction"], string> = {
  CREATE: "Créera",
  UPDATE: "Mettra à jour",
  SKIP: "Sans changement",
  BLOCKED: "Bloqué",
};

const RESOLUTION_LABEL: Record<string, string> = {
  EXISTING: "Existante",
  WOULD_CREATE: "Sera créée",
  AMBIGUOUS: "Ambiguë",
  ERROR: "Erreur",
};

function formatResolution(res: { state: string; displayName: string } | null): string {
  if (!res) return "—";
  const label = RESOLUTION_LABEL[res.state] ?? res.state;
  return res.displayName ? `${label} (${res.displayName})` : label;
}

export default function CatalogueImportPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [restaurantId, setRestaurantId] = useState("");
  const [establishments, setEstablishments] = useState<OperatorEstablishmentListItem[]>([]);
  const [establishmentsError, setEstablishmentsError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<CatalogueImportAnalysisResult | null>(null);
  // v1.3 -- établissement pour lequel `result` a RÉELLEMENT été généré
  // (capturé au lancement de l'analyse, jamais déduit de `restaurantId`
  // courant). Garde-fou explicite pour l'invariant "établissement
  // affiché = cible Preview = cible Commit", voir l'en-tête de ce
  // fichier.
  const [previewRestaurantId, setPreviewRestaurantId] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<CatalogueImportCommitResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // v1.3 -- jeton de génération de requête Analyser : incrémenté à
  // chaque événement qui invalide un Preview en vol (nouveau clic
  // Analyser, changement d'établissement, changement de fichier). Une
  // réponse asynchrone dont le jeton capturé ne correspond plus à
  // `analyzeTokenRef.current` à sa résolution est silencieusement
  // ignorée -- jamais affichée, jamais éligible au commit. Voir
  // l'en-tête de ce fichier ("RACE ASYNCHRONE PREVIEW").
  const analyzeTokenRef = useRef(0);

  useEffect(() => {
    (async () => {
      const user = await getUser();
      if (!user) {
        router.replace("/dashboard/login");
        return;
      }
      // ADMIN ONLY (v1.1) -- voir l'en-tête de ce fichier. Aucune
      // résolution de restaurant, aucun chargement du répertoire des
      // établissements, tant que l'opérateur n'est pas confirmé : un
      // marchand authentifié (avec ou sans restaurant en propre) est
      // redirigé ici, avant que quoi que ce soit lié à l'import ne
      // soit résolu ou rendu.
      const ok = await isScanymOperator();
      setAuthorized(ok);
      setAuthChecked(true);
      if (!ok) {
        router.replace("/dashboard");
        return;
      }
      // v1.2 -- `?r=` est TOUJOURS la valeur par défaut, posée AVANT
      // le chargement de la liste des établissements et JAMAIS
      // réécrite ensuite par cette liste (ordre du tableau, premier
      // élément, ou toute autre heuristique) : voir l'en-tête de ce
      // fichier pour le bug de Production corrigé par ce lot. En
      // l'absence de `?r=`, `restaurantId` reste vide -- l'Admin
      // choisit explicitement, aucune présélection automatique.
      const wanted = new URLSearchParams(window.location.search).get("r");
      if (wanted) setRestaurantId(wanted);
      try {
        const list = await listOperatorEstablishments();
        setEstablishments(list);
      } catch {
        // Échec de chargement du répertoire Admin/Opérateur : `?r=`
        // (s'il est présent) reste utilisable pour Analyser/Confirmer,
        // mais aucun changement d'établissement explicite n'est
        // proposé tant que la liste n'a pas pu être chargée.
        setEstablishmentsError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  /**
   * v1.2 -- changer d'établissement (sélection explicite de l'Admin)
   * invalide immédiatement tout Preview/résultat de commit déjà
   * affiché : jamais de confirmation sur un aperçu généré pour un
   * autre établissement (règle mandatée, voir en-tête de fichier).
   * Même réinitialisation que le changement de fichier ci-dessous.
   *
   * v1.3 -- incrémente AUSSI `analyzeTokenRef` : une analyse déjà en
   * vol pour l'ANCIEN établissement, même si aucun nouveau clic
   * Analyser n'a encore eu lieu, doit être invalidée immédiatement
   * (race asynchrone Preview, voir en-tête de fichier) -- pas
   * seulement le nettoyage visuel de `result`/`commitResult` ci-dessus.
   * Réinitialise aussi `analyzing` : la requête en vol (le cas
   * échéant) vient d'être invalidée par le changement de jeton --
   * son `finally` ne réinitialisera plus jamais `analyzing` lui-même
   * (jeton devenu obsolète), donc sans cette ligne le bouton
   * "Analyser" resterait bloqué indéfiniment sur "Analyse en cours…"
   * au lieu de permettre immédiatement une nouvelle Analyse pour le
   * nouvel établissement.
   */
  function handleRestaurantChange(nextRestaurantId: string) {
    analyzeTokenRef.current += 1;
    setRestaurantId(nextRestaurantId);
    setResult(null);
    setPreviewRestaurantId(null);
    setCommitResult(null);
    setConfirmOpen(false);
    setAnalyzing(false);
  }

  /**
   * v1.3 -- même raisonnement que `handleRestaurantChange` ci-dessus,
   * appliqué au fichier sélectionné : un Preview en vol pour l'ANCIEN
   * fichier doit être invalidé dès que le fichier change, avant même
   * qu'un nouveau clic Analyser n'ait lieu. Réinitialise aussi
   * `analyzing` pour la même raison (voir commentaire ci-dessus).
   */
  function handleFileChange(nextFile: File | null) {
    analyzeTokenRef.current += 1;
    setFile(nextFile);
    setResult(null);
    setPreviewRestaurantId(null);
    setCommitResult(null);
    setConfirmOpen(false);
    setAnalyzing(false);
  }

  /**
   * RACE ASYNCHRONE PREVIEW (v1.3) -- voir l'en-tête de ce fichier.
   * `analysisRestaurantId` et `myToken` sont capturés AVANT l'appel
   * asynchrone ; à la résolution (succès ou erreur), la réponse n'est
   * acceptée QUE si `analyzeTokenRef.current === myToken`, c'est-à-dire
   * si aucun événement invalidant (nouveau clic Analyser, changement
   * d'établissement, changement de fichier) n'a eu lieu entre-temps.
   * Toute réponse obsolète est silencieusement ignorée -- jamais
   * affichée, jamais éligible au commit ("latest request wins").
   */
  async function handleAnalyze() {
    if (!file || !restaurantId) return;
    const myToken = (analyzeTokenRef.current += 1);
    const analysisRestaurantId = restaurantId;
    setAnalyzing(true);
    setResult(null);
    setPreviewRestaurantId(null);
    setCommitResult(null);
    setConfirmOpen(false);
    try {
      const analysis = await analyzeCatalogueImportFile(file, analysisRestaurantId);
      if (analyzeTokenRef.current !== myToken) return; // réponse obsolète, ignorée
      setResult(analysis);
      setPreviewRestaurantId(analysisRestaurantId);
    } catch (e) {
      if (analyzeTokenRef.current !== myToken) return; // réponse obsolète, ignorée
      setResult({
        kind: "STRUCTURAL_ERROR",
        code: "MALFORMED_WORKBOOK",
        message: e instanceof Error ? e.message : "Erreur inattendue pendant l'analyse.",
      });
    } finally {
      if (analyzeTokenRef.current === myToken) setAnalyzing(false);
    }
  }

  /**
   * Confirmation explicite (mandat OB-4 v1.1). N'utilise JAMAIS
   * `result` (le Preview déjà affiché) pour décider quoi écrire --
   * `commitCatalogueImport` ré-analyse intégralement `file` en interne
   * (relecture fraîche du fichier ET du catalogue). `result` sert
   * uniquement à AFFICHER le résumé Preview et à activer le bouton --
   * jamais d'entrée de l'écriture elle-même.
   *
   * v1.3 -- garde-fou explicite supplémentaire (défense en profondeur,
   * pas seulement l'état désactivé du bouton) : le commit est refusé
   * si `previewRestaurantId` (l'établissement pour lequel le Preview
   * affiché a réellement été généré) ne correspond plus exactement à
   * `restaurantId` (l'établissement actuellement sélectionné). La
   * revalidation serveur OB-4 ci-dessous reste inchangée et s'exécute
   * toujours en plus de ce garde-fou.
   */
  async function handleConfirmCommit() {
    if (!file || !restaurantId || result?.kind !== "OK" || previewRestaurantId !== restaurantId) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const commit = await commitCatalogueImport(file, restaurantId);
      setCommitResult(commit);
      setConfirmOpen(false);
    } catch (e) {
      setCommitResult({
        kind: "STRUCTURAL_ERROR",
        code: "MALFORMED_WORKBOOK",
        message: e instanceof Error ? e.message : "Erreur inattendue pendant la confirmation d'import.",
      });
      setConfirmOpen(false);
    } finally {
      setCommitting(false);
    }
  }

  if (!authChecked) {
    return <div className="p-6 text-sm text-gray-500">Vérification des autorisations…</div>;
  }

  if (!authorized) {
    // Ne laisse jamais cette page affichée à un utilisateur légitime
    // mais non-opérateur : redirection déjà déclenchée ci-dessus
    // (router.replace("/dashboard")), pas un simple masquage de
    // bouton -- même idiome que app/admin/establishments/{page,new,
    // cockpit}.tsx.
    return <div className="p-6 text-sm text-gray-500">Accès réservé aux opérateurs Scanym.</div>;
  }

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Chargement…</div>;
  }

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Import de catalogue (aperçu)</h1>
        <a
          href={restaurantId ? `/dashboard/catalogue?r=${restaurantId}` : "/dashboard/catalogue"}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Retour au catalogue
        </a>
      </div>

      <p className="mb-4 text-sm text-gray-600">
        Cette page analyse un fichier <code>catalogue.xlsx</code> (ou <code>.csv</code>) et affiche un aperçu
        détaillé, ligne par ligne — <strong>aucune modification n&rsquo;est appliquée au catalogue tant que
        l&rsquo;import n&rsquo;est pas explicitement confirmé</strong>. La confirmation relit systématiquement
        l&rsquo;état réel du catalogue au moment du clic, jamais l&rsquo;aperçu affiché.
      </p>

      <div className="mb-6 rounded-lg border border-gray-200 p-4">
        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium text-gray-700">Établissement</label>
          <select
            className="w-full rounded border border-gray-300 p-2 text-sm"
            value={restaurantId}
            onChange={(e) => handleRestaurantChange(e.target.value)}
          >
            <option value="">— Sélectionner un établissement —</option>
            {restaurantId && !establishments.some((e) => e.restaurantId === restaurantId) && (
              // `?r=` (ou une sélection précédente) ne correspond à
              // aucun établissement du répertoire Admin/Opérateur
              // chargé -- affiché explicitement plutôt que de laisser
              // le navigateur retomber silencieusement sur le premier
              // élément réel de la liste (c'est exactement le bug de
              // Production corrigé par ce lot).
              <option value={restaurantId}>Établissement inconnu ({restaurantId})</option>
            )}
            {establishments.map((e) => (
              <option key={e.restaurantId} value={e.restaurantId}>
                {e.name} ({e.slug})
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm font-semibold text-gray-800">
            Établissement sélectionné :{" "}
            {restaurantId
              ? (establishments.find((e) => e.restaurantId === restaurantId)?.name ??
                `établissement inconnu (${restaurantId})`)
              : "aucun"}
          </p>
          {establishmentsError && (
            <p className="mt-1 text-xs text-red-600">
              Impossible de charger le répertoire des établissements — le changement explicite d&rsquo;établissement
              est indisponible pour le moment ; l&rsquo;établissement fourni via <code>?r=</code> reste utilisable.
            </p>
          )}
        </div>

        <div className="mb-3">
          <label className="mb-1 block text-sm font-medium text-gray-700">Fichier (.xlsx prioritaire, .csv accepté)</label>
          <input
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
        </div>

        <button
          type="button"
          disabled={!file || !restaurantId || analyzing}
          onClick={handleAnalyze}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {analyzing ? "Analyse en cours…" : "Analyser"}
        </button>

        <button
          type="button"
          disabled={
            !file ||
            !restaurantId ||
            result?.kind !== "OK" ||
            result.report.eligibility === "NOT_ELIGIBLE" ||
            // v1.3 -- garde-fou explicite : jamais actif si le Preview
            // affiché ne cible pas l'établissement ACTUELLEMENT
            // sélectionné (voir en-tête de fichier, "RACE ASYNCHRONE
            // PREVIEW"). En pratique déjà garanti par le nettoyage de
            // `result`/`previewRestaurantId` sur tout changement de
            // contexte, mais vérifié ici indépendamment plutôt que de
            // se reposer uniquement sur cette absence de valeur.
            previewRestaurantId !== restaurantId ||
            committing
          }
          title={
            result?.kind === "OK" && result.report.eligibility === "NOT_ELIGIBLE"
              ? "Le fichier contient des lignes bloquées — corrigez-les puis ré-analysez avant de confirmer."
              : undefined
          }
          onClick={() => setConfirmOpen(true)}
          className="ml-3 rounded border border-blue-600 px-4 py-2 text-sm font-medium text-blue-700 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400"
        >
          Confirmer l&rsquo;import
        </button>
      </div>

      {confirmOpen && result?.kind === "OK" && (
        <div className="mb-6 rounded-lg border border-blue-300 bg-blue-50 p-4 text-sm">
          <p className="mb-2 font-medium text-blue-900">Confirmer cet import ?</p>
          <p className="mb-3 text-blue-800">
            {result.report.rows.filter((r) => r.plannedAction === "CREATE").length} produit(s) créé(s),{" "}
            {result.report.rows.filter((r) => r.plannedAction === "UPDATE").length} mis à jour,{" "}
            {result.report.rows.filter((r) => r.plannedAction === "SKIP").length} sans changement.
            {result.report.eligibility === "ELIGIBLE_WITH_WARNINGS" &&
              " Le fichier contient des avertissements (non bloquants) — vérifiez le détail des lignes ci-dessous avant de continuer."}{" "}
            L&rsquo;état réel du catalogue sera relu au moment de la confirmation : si un import concurrent a
            entre-temps modifié le catalogue, le résultat reflétera cet état réel, jamais cet aperçu figé.
          </p>
          <button
            type="button"
            disabled={committing}
            onClick={handleConfirmCommit}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {committing ? "Import en cours…" : "Oui, importer maintenant"}
          </button>
          <button
            type="button"
            disabled={committing}
            onClick={() => setConfirmOpen(false)}
            className="ml-3 rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600"
          >
            Annuler
          </button>
        </div>
      )}

      {commitResult?.kind === "STRUCTURAL_ERROR" && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Import impossible ({commitResult.code})</p>
          <p>{commitResult.message}</p>
        </div>
      )}

      {commitResult?.kind === "NOT_ELIGIBLE" && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Import refusé — le catalogue a changé depuis l&rsquo;aperçu</p>
          <p>
            La relecture fraîche effectuée au moment de la confirmation a trouvé {commitResult.report.blockedRows}{" "}
            ligne(s) désormais bloquée(s) (ex. un import concurrent a créé une catégorie ambiguë entre-temps).
            Ré-analysez le fichier pour voir l&rsquo;état à jour avant de confirmer à nouveau.
          </p>
        </div>
      )}

      {commitResult?.kind === "COMMITTED" && (
        <div className="mb-6 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900">
          <p className="mb-2 font-medium">Import terminé — {commitResult.fileName}</p>
          <p className="mb-2">
            {commitResult.categoriesCreated} catégorie(s) créée(s) · {commitResult.subcategoriesCreated} sous-catégorie(s)
            créée(s) · {commitResult.productsCreated} produit(s) créé(s) · {commitResult.productsUpdated} mis à jour ·{" "}
            {commitResult.productsSkipped} sans changement
            {commitResult.productsFailed > 0 && (
              <span className="font-semibold text-red-700"> · {commitResult.productsFailed} ligne(s) en échec</span>
            )}
            .
          </p>
          {commitResult.productsFailed > 0 && (
            <div className="mt-2 overflow-x-auto rounded border border-red-200 bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-red-50 text-left uppercase text-red-700">
                  <tr>
                    <th className="p-2">Ligne</th>
                    <th className="p-2">Résultat</th>
                    <th className="p-2">Détail</th>
                  </tr>
                </thead>
                <tbody>
                  {commitResult.rows
                    .filter((r) => r.outcome === "FAILED")
                    .map((r) => (
                      <tr key={r.row} className="border-t border-red-100 align-top">
                        <td className="p-2">{r.row}</td>
                        <td className="p-2">{COMMIT_ROW_OUTCOME_LABEL[r.outcome]}</td>
                        <td className="p-2">{r.errorMessage ?? "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {result?.kind === "STRUCTURAL_ERROR" && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Fichier non analysable ({result.code})</p>
          <p>{result.message}</p>
          {result.missingHeaders && result.missingHeaders.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {result.missingHeaders.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result?.kind === "OK" && (
        <>
          <div className="mb-4 rounded-lg border border-gray-200 p-4">
            <p className="mb-2 text-sm">
              <strong>{result.fileName}</strong> ({result.sourceFormat.toUpperCase()}) —{" "}
              {result.report.totalRows} ligne(s) analysée(s).
            </p>
            <p className="mb-2 text-sm">
              Éligibilité :{" "}
              <span
                className={
                  result.report.eligibility === "ELIGIBLE"
                    ? "font-semibold text-green-700"
                    : result.report.eligibility === "ELIGIBLE_WITH_WARNINGS"
                      ? "font-semibold text-amber-700"
                      : "font-semibold text-red-700"
                }
              >
                {result.report.eligibility === "ELIGIBLE" && "Éligible pour un futur import"}
                {result.report.eligibility === "ELIGIBLE_WITH_WARNINGS" && "Éligible avec avertissements"}
                {result.report.eligibility === "NOT_ELIGIBLE" && "Non éligible — erreurs bloquantes présentes"}
              </span>
            </p>
            <p className="text-xs text-gray-500">
              {result.report.okRows} OK · {result.report.warningRows} avertissement(s) · {result.report.blockedRows} bloquée(s)
            </p>
            {result.report.columnMapWarnings.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-gray-500">
                {result.report.columnMapWarnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="p-2">Ligne</th>
                  <th className="p-2">Statut</th>
                  <th className="p-2">Nom</th>
                  <th className="p-2">Catégorie</th>
                  <th className="p-2">Sous-catégorie</th>
                  <th className="p-2">Photo</th>
                  <th className="p-2">Action prévue</th>
                  <th className="p-2">Détails</th>
                </tr>
              </thead>
              <tbody>
                {result.report.rows.map((row) => (
                  <tr key={row.row} className="border-t border-gray-100 align-top">
                    <td className="p-2">{row.row}</td>
                    <td className="p-2">
                      <span
                        className={
                          row.status === "OK"
                            ? "text-green-700"
                            : row.status === "WARNING"
                              ? "text-amber-700"
                              : "text-red-700"
                        }
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                    </td>
                    <td className="p-2">{row.normalizedValues.name || "—"}</td>
                    <td className="p-2">{formatResolution(row.resolvedCategory)}</td>
                    <td className="p-2">{formatResolution(row.resolvedSubcategory)}</td>
                    <td className="p-2">{row.photoFilename ?? "—"}</td>
                    <td className="p-2">{ACTION_LABEL[row.plannedAction]}</td>
                    <td className="p-2">
                      {[...row.errors, ...row.warnings, ...row.infos].map((issue, i) => (
                        <div
                          key={i}
                          className={
                            issue.severity === "BLOCKING_ERROR"
                              ? "text-red-700"
                              : issue.severity === "WARNING"
                                ? "text-amber-700"
                                : "text-gray-500"
                          }
                        >
                          {issue.message}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
