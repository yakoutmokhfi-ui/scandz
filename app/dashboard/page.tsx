"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, signOut } from "@/lib/services/auth";
import { subscribeToOrders } from "@/lib/services/realtime";
import {
  getDashboardOrders,
  getMerchantRestaurants,
  getReceiptSettings,
  getRestaurantSettings,
  updateOrderStatus,
} from "@/lib/services/dashboard";
import type {
  DashboardOrder,
  MerchantRestaurant,
  OrderStatus,
  ReceiptSettings,
} from "@/lib/dashboard-types";
import OrderCard from "@/components/dashboard/OrderCard";
import DashboardNav from "@/components/dashboard/DashboardNav";
import { resolveRestaurantContext } from "@/lib/dashboard-nav";
import { isScanymOperator, getEstablishmentSummary } from "@/lib/services/establishments";
import { translate, type Lang } from "@/lib/i18n";

export default function DashboardPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  /**
   * CONTEXT HARDENING v1 (§4.B) -- établissement explicitement demandé
   * par `?r=` mais non résoluble : AUCUN établissement n'est
   * sélectionné, donc aucune commande n'est chargée et aucun
   * abonnement temps réel n'est ouvert.
   */
  const [unavailableContextId, setUnavailableContextId] = useState<string | null>(null);
  /**
   * CONTEXT HARDENING v1 -- nom de l'établissement consulté en contexte
   * OPÉRATEUR (hors des rattachements du compte), résolu via l'aide
   * existante `getEstablishmentSummary`. L'autorité opérateur vient
   * d'`isScanymOperator()`, jamais de l'URL (mandat §11).
   */
  const [operatorRestaurantName, setOperatorRestaurantName] = useState<string | null>(null);
  const [restaurantId, setRestaurantId] = useState("");
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [staffLanguage, setStaffLanguage] = useState<string>("fr");
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings | null>(null);
  /**
   * PRINTED MERCHANT RECEIPT / VAT + LEGAL INFO FIX v1 (Claude Monet,
   * root cause confirmed par Cat Stevens) -- ferme le RACE identifié
   * entre le chargement de `receiptSettings` et le clic sur
   * "Imprimer" (OrderCard.handlePrint -> printReceipt ->
   * buildReceiptHtml).
   *
   * `receiptSettings === null` est AMBIGU par construction :
   * `getReceiptSettings()` résout LÉGITIMEMENT à `null` quand un
   * établissement n'a simplement AUCUNE ligne receipt_settings
   * (onboardé après V29, cf. commentaire jumeau dans
   * app/dashboard/settings/page.tsx) -- donc tester `receiptSettings
   * !== null` pour décider si l'impression peut démarrer bloquerait
   * PERMANENMENT ces établissements. Un drapeau de complétude DÉDIÉ,
   * distinct de la VALEUR elle-même, est nécessaire : `true` dès que
   * la réponse (positive OU "aucune ligne") du restaurant COURANT est
   * arrivée, jamais avant.
   *
   * Avant ce correctif, `OrderCard` recevait `receiptSettings` (déjà
   * son état initial `null`) sans aucune indication qu'un chargement
   * était PEUT-ÊTRE encore en cours -- un gérant pouvait cliquer
   * "Imprimer" sur une commande fraîchement arrivée (le son d'alerte
   * incite justement à agir vite) avant que `getReceiptSettings()`
   * n'ait résolu, imprimant un ticket SANS AUCUNE information légale
   * (legal_name/legal_address/phone/email/tax_identifier/
   * registration_number/footer_text -- lib/receipt.ts ne lit ces
   * champs QUE depuis `settings`, sans repli, voir buildReceiptHtml).
   */
  const [receiptSettingsReady, setReceiptSettingsReady] = useState(false);
  /**
   * RECEIPT v1.1 -- remédiation RECEIPT-V1-ORDER-SETTINGS-RACE-01.
   *
   * PROVENANCE explicite des deux jeux de données : pour QUEL
   * restaurant l'ensemble actuellement en mémoire a-t-il été chargé ?
   * `null` = rien de fiable en mémoire pour le restaurant courant.
   *
   * v1 ne suivait cette provenance pour AUCUN des deux : `orders` et
   * `receiptSettings` étaient deux états indépendants, sans lien
   * vérifiable avec le restaurant sélectionné. Il suffisait donc que
   * les RÉGLAGES de B arrivent pendant que les COMMANDES de A étaient
   * encore affichées pour qu'une commande de A devienne imprimable
   * avec les mentions légales de B (constat d'audit, blocage
   * RECEIPT-V1-ORDER-SETTINGS-RACE-01). L'impression n'est désormais
   * autorisée que lorsque ces deux provenances ET le restaurant
   * sélectionné désignent le MÊME établissement (voir
   * `printRestaurantId` plus bas).
   */
  const [ordersLoadedForRestaurantId, setOrdersLoadedForRestaurantId] = useState<string | null>(null);
  const [receiptSettingsLoadedForRestaurantId, setReceiptSettingsLoadedForRestaurantId] =
    useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const knownOrderIds = useRef<Set<string>>(new Set());
  /**
   * Garde ANTI-RÉPONSE-HORS-ORDRE, même patron déjà établi par
   * `legalRequestSeqRef` (app/dashboard/settings/page.tsx, MERCHANT
   * LEGAL & TAX PROFILE v1) : une bascule rapide entre deux
   * établissements ne doit JAMAIS laisser une réponse PÉRIMÉE (celle
   * du restaurant PRÉCÉDENT, résolue en second) marquer
   * `receiptSettingsReady = true` avec les réglages d'un AUTRE
   * restaurant -- ce serait une fuite tenant (impression du ticket
   * légal d'un établissement sur la commande d'un autre).
   */
  const receiptSettingsSeqRef = useRef(0);
  /**
   * RECEIPT v1.1 -- garde de génération pour les COMMANDES, strictement
   * symétrique à `receiptSettingsSeqRef` ci-dessus. C'est LA protection
   * qui manquait en v1 : `loadOrders()` appliquait `setOrders()` sans
   * jamais vérifier que sa réponse correspondait encore à la requête la
   * plus récente -- une réponse de commandes du restaurant A résolue
   * APRÈS la sélection de B écrasait donc l'état avec les commandes de A
   * (constat d'audit, point 8).
   */
  const ordersRequestSeqRef = useRef(0);
  /**
   * Miroir du restaurant SÉLECTIONNÉ, lisible depuis une continuation
   * asynchrone sans risque de fermeture périmée (`restaurantId` capturé
   * dans une closure vaut celui du rendu où la requête est partie, pas
   * celui qui est sélectionné au moment où la réponse arrive). Les deux
   * sont comparés : la génération prouve « c'est bien la requête la plus
   * récente », le restaurant prouve « et elle concerne bien le
   * restaurant affiché » (mandat v1.1 §3.B).
   */
  const selectedRestaurantIdRef = useRef("");

  const currentMapping = mappings.find((item) => item.restaurant_id === restaurantId);
  const restaurantName =
    currentMapping?.restaurants?.name ?? operatorRestaurantName ?? "Restaurant";

  const playSound = useCallback(() => {
    if (!soundEnabled) return;
    const AudioContextClass = window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.25);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.26);
    oscillator.addEventListener("ended", () => void context.close());
  }, [soundEnabled]);

  const loadOrders = useCallback(async (notify = false) => {
    // RECEIPT v1.1 (RECEIPT-V1-ORDER-SETTINGS-RACE-01) -- la requête
    // capture le restaurant pour lequel elle part ET sa génération.
    // Aucune hypothèse de timing n'est faite : la réponse devra
    // PROUVER, à son retour, qu'elle est toujours la plus récente ET
    // qu'elle concerne toujours le restaurant sélectionné.
    const requestedRestaurantId = restaurantId;
    if (!requestedRestaurantId) return;
    const seq = ++ordersRequestSeqRef.current;

    /** Une réponse ne peut être appliquée que si les DEUX tiennent. */
    const isStillCurrent = () =>
      seq === ordersRequestSeqRef.current &&
      requestedRestaurantId === selectedRestaurantIdRef.current;

    try {
      const next = await getDashboardOrders(requestedRestaurantId, showHistory);
      // Réponse PÉRIMÉE (requête plus récente, et/ou restaurant changé
      // depuis) -- ignorée INTÉGRALEMENT : ni `orders`, ni
      // `knownOrderIds`, ni la sonnerie ne doivent être touchés, sans
      // quoi les commandes d'un AUTRE établissement réapparaîtraient.
      if (!isStillCurrent()) return;

      const newOrders = next.filter(
        (order) => order.status === "new" && !knownOrderIds.current.has(order.id)
      );
      // Commit ATOMIQUE (même passe de rendu) : `orders` et sa
      // provenance sont posés ensemble -- ils ne peuvent jamais se
      // contredire, même un instant. Même discipline que le commit
      // atomique de `legalProfileLoadedRestaurantId` dans
      // app/dashboard/settings/page.tsx.
      setOrders(next);
      setOrdersLoadedForRestaurantId(requestedRestaurantId);
      next.forEach((order) => knownOrderIds.current.add(order.id));
      if (notify && newOrders.length > 0) playSound();
    } catch (loadError) {
      // Une erreur périmée ne doit pas non plus s'afficher : elle
      // concernerait un restaurant qui n'est plus à l'écran.
      if (!isStillCurrent()) return;
      setError(loadError instanceof Error ? loadError.message : "Chargement impossible");
    }
  }, [playSound, restaurantId, showHistory]);

  const dt = (k: string, p?: Record<string, string | number>) =>
    translate(staffLanguage as Lang, k, p);

  useEffect(() => {
    async function initialize() {
      const session = await getSession();
      if (!session) {
        router.replace("/dashboard/login");
        return;
      }

      try {
        const [nextMappings, opFlag] = await Promise.all([
          getMerchantRestaurants(),
          isScanymOperator(),
        ]);
        setMappings(nextMappings);
        // Conserve l'établissement choisi sur l'autre page. Lu depuis
        // l'URL côté client : évite d'imposer une frontière Suspense au
        // prérendu.
        //
        // CONTEXT HARDENING v1 -- résolution UNIQUE et partagée
        // (lib/dashboard-nav.ts). Cette page repliait sur
        // `nextMappings[0]` quand `?r=` désignait un établissement
        // introuvable, et n'avait AUCUNE branche opérateur : venir de
        // "Réglages / Au lait cru" ouvrait donc les commandes d'un
        // AUTRE établissement. Les deux défauts sont corrigés ici.
        const wanted = new URLSearchParams(window.location.search).get("r");
        const resolution = resolveRestaurantContext({
          requestedId: wanted,
          mappings: nextMappings,
          isOperator: opFlag,
        });

        if (resolution.kind === "unavailable") {
          // §4.B -- fail closed : aucune sélection, donc aucun
          // chargement de commandes et aucun abonnement.
          setUnavailableContextId(resolution.requestedId);
        } else if (resolution.kind === "none") {
          setError("Ce compte n'est lié à aucun restaurant.");
        } else {
          setUnavailableContextId(null);
          // La référence utilisée par les gardes asynchrones est posée
          // AVANT toute requête (voir l'effet de changement
          // d'établissement plus bas).
          selectedRestaurantIdRef.current = resolution.restaurantId;
          setRestaurantId(resolution.restaurantId);
          if (resolution.source === "operator") {
            try {
              const summary = await getEstablishmentSummary(resolution.restaurantId);
              setOperatorRestaurantName(summary.name);
            } catch {
              // Best-effort : un nom introuvable n'empêche pas de
              // continuer (l'ID reste la source de vérité).
            }
          }
        }
      } catch (initError) {
        setError(initError instanceof Error ? initError.message : "Initialisation impossible");
      } finally {
        setLoading(false);
      }
    }
    void initialize();
  }, [router]);

  useEffect(() => {
    if (!restaurantId) return;
    knownOrderIds.current = new Set();

    // RECEIPT v1.1 (RECEIPT-V1-ORDER-SETTINGS-RACE-01) -- invariant §3.A
    // du mandat, appliqué AVANT que la moindre requête ne parte :
    //
    //   1. le restaurant sélectionné devient la référence que toute
    //      continuation asynchrone devra retrouver ;
    //   2. la génération des COMMANDES est incrémentée : toute requête
    //      de commandes encore en vol (celles du restaurant précédent)
    //      est invalidée à cet instant précis, même si aucune nouvelle
    //      requête n'était partie ensuite ;
    //   3. les commandes affichées sont VIDÉES immédiatement, et leur
    //      provenance effacée -- les commandes du restaurant précédent
    //      cessent donc d'être affichées ET d'être imprimables au
    //      moment même de la bascule, sans attendre aucune réponse
    //      réseau (le mandat demande explicitement de préférer ce
    //      vidage immédiat).
    selectedRestaurantIdRef.current = restaurantId;
    ordersRequestSeqRef.current += 1;
    setOrders([]);
    setOrdersLoadedForRestaurantId(null);

    void loadOrders(false);

    // Réinitialisation SYNCHRONE (avant même que la requête ne parte)
    // -- ferme la fenêtre de fuite tenant : tant que la réponse pour
    // CE restaurant n'est pas revenue, ni les anciens réglages
    // (potentiellement ceux d'un AUTRE établissement) ni "prêt à
    // imprimer" ne restent affichés/actifs.
    const seq = ++receiptSettingsSeqRef.current;
    setReceiptSettings(null);
    setReceiptSettingsReady(false);
    setReceiptSettingsLoadedForRestaurantId(null);
    getReceiptSettings(restaurantId)
      .then((settings) => {
        // Réponse PÉRIMÉE (un changement de restaurant plus récent a
        // déjà invalidé cette requête) -- ignorée intégralement,
        // jamais appliquée à l'état d'un restaurant qui n'est plus
        // celui sélectionné.
        // RECEIPT v1.1 -- au contrôle de génération s'ajoute le
        // contrôle du restaurant réellement sélectionné (mandat §3.C),
        // symétrique de celui de `loadOrders`.
        if (seq !== receiptSettingsSeqRef.current) return;
        if (restaurantId !== selectedRestaurantIdRef.current) return;
        setReceiptSettings(settings);
        // `settings === null` est un état RÉUSSI et LÉGITIME (aucune
        // ligne receipt_settings pour cet établissement) -- ready
        // passe à `true` dans les deux cas, jamais seulement si un
        // objet non nul est revenu (voir commentaire d'état
        // ci-dessus).
        // Commit ATOMIQUE : la valeur, sa provenance et le drapeau
        // "prêt" sont posés dans la même passe de rendu.
        setReceiptSettingsLoadedForRestaurantId(restaurantId);
        setReceiptSettingsReady(true);
      })
      .catch((settingsError) => {
        if (seq !== receiptSettingsSeqRef.current) return;
        if (restaurantId !== selectedRestaurantIdRef.current) return;
        // Échec RÉEL (pas "aucune ligne") -- reste `false` : impression
        // désactivée tant qu'une lecture réussie n'a pas confirmé
        // l'état réglages pour CE restaurant (repli sûr, même
        // discipline que legalProfileReady dans app/dashboard/
        // settings/page.tsx).
        setError(settingsError instanceof Error ? settingsError.message : "Configuration ticket indisponible");
      });

    // Langue du ticket, réglée par le gérant dans ses paramètres.
    // Même source que le message WhatsApp : restaurant_configs.
    getRestaurantSettings(restaurantId)
      .then((s) => setStaffLanguage(s.staff_receipt_language ?? "fr"))
      .catch(() => setStaffLanguage("fr"));

    return subscribeToOrders(restaurantId, () => void loadOrders(true));
  }, [loadOrders, restaurantId]);

  useEffect(() => {
    if (restaurantId) void loadOrders(false);
  }, [showHistory, restaurantId, loadOrders]);

  async function changeStatus(orderId: string, status: OrderStatus) {
    setBusyOrderId(orderId);
    setError(null);
    try {
      await updateOrderStatus(orderId, status);
      await loadOrders(false);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Changement de statut impossible");
    } finally {
      setBusyOrderId(null);
    }
  }

  async function logout() {
    await signOut();
    router.replace("/dashboard/login");
  }

  /**
   * RECEIPT v1.1 (RECEIPT-V1-ORDER-SETTINGS-RACE-01) -- porte
   * d'impression unique (mandat §3.D).
   *
   * Vaut l'identifiant du restaurant UNIQUEMENT lorsque les QUATRE
   * conditions désignent le même établissement :
   *   - un restaurant est sélectionné ;
   *   - le jeu de COMMANDES en mémoire a été chargé pour LUI ;
   *   - les RÉGLAGES ticket en mémoire ont été chargés pour LUI ;
   *   - ces réglages sont effectivement prêts (réponse aboutie).
   * Sinon `null` : rien n'est imprimable, quel que soit l'état de l'UI.
   *
   * `OrderCard` y ajoute la dernière condition, par commande :
   * `order.restaurant_id === printRestaurantId` -- de sorte qu'une
   * commande étrangère resterait bloquée même si cette porte-ci était
   * ouverte.
   */
  const printRestaurantId =
    restaurantId &&
    ordersLoadedForRestaurantId === restaurantId &&
    receiptSettingsLoadedForRestaurantId === restaurantId &&
    receiptSettingsReady
      ? restaurantId
      : null;

  if (loading) return <main className="min-h-screen bg-stone-100 p-8">Chargement…</main>;

  // CONTEXT HARDENING v1 (§4.B) -- contexte explicitement demandé mais
  // non résoluble : état dédié, aucun établissement sélectionné, aucune
  // commande chargée, aucun abonnement ouvert.
  if (unavailableContextId) {
    return (
      <main className="min-h-screen bg-stone-100 p-8">
        <div
          role="alert"
          data-context-unavailable={unavailableContextId}
          className="mx-auto max-w-2xl rounded-2xl bg-white p-6 text-sm font-semibold text-red-700 shadow-sm"
        >
          {dt("dsContextUnavailable")}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-stone-100 pb-12">
      <DashboardNav
        restaurantName={restaurantName}
        restaurantId={restaurantId}
        mappings={mappings}
        staffLanguage={staffLanguage}
        onSelectRestaurant={setRestaurantId}
      >
        <button
          onClick={() => { setSoundEnabled(true); playSound(); }}
          className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-bold"
        >
          {soundEnabled ? dt("dsSoundOn") : dt("dsSoundOff")}
        </button>
      </DashboardNav>

      <section className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-stone-900">{dt("dsOrders")}</h2>
            <p className="text-sm text-stone-600">{dt("dsSubtitle")} · {receiptSettings?.paper_width_mm ?? 58} mm</p>
          </div>
              <button onClick={() => setShowHistory((value) => !value)} className="rounded-xl bg-white px-4 py-2 text-sm font-bold shadow-sm">
            {showHistory ? dt("dsActiveOrders") : dt("dsHistory")}
          </button>
        </div>

        {error && <div className="mb-5 rounded-xl bg-red-50 p-4 text-sm font-semibold text-red-700">{error}</div>}

        {orders.length === 0 ? (
          <div className="rounded-2xl bg-white p-10 text-center text-stone-500 shadow-sm">Aucune commande à afficher.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {orders.map((order) => (
              <OrderCard
              staffLanguage={staffLanguage}
                key={order.id}
                order={order}
                restaurantName={restaurantName}
                receiptSettings={receiptSettings}
                receiptSettingsReady={receiptSettingsReady}
                printRestaurantId={printRestaurantId}
                onStatus={changeStatus}
                busy={busyOrderId === order.id}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
