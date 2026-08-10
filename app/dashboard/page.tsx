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
import { translate, type Lang } from "@/lib/i18n";

export default function DashboardPage() {
  const router = useRouter();
  const [mappings, setMappings] = useState<MerchantRestaurant[]>([]);
  const [restaurantId, setRestaurantId] = useState("");
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [staffLanguage, setStaffLanguage] = useState<string>("fr");
  const [receiptSettings, setReceiptSettings] = useState<ReceiptSettings | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const knownOrderIds = useRef<Set<string>>(new Set());

  const currentMapping = mappings.find((item) => item.restaurant_id === restaurantId);
  const restaurantName = currentMapping?.restaurants?.name ?? "Restaurant";

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
    if (!restaurantId) return;
    try {
      const next = await getDashboardOrders(restaurantId, showHistory);
      const newOrders = next.filter(
        (order) => order.status === "new" && !knownOrderIds.current.has(order.id)
      );
      setOrders(next);
      next.forEach((order) => knownOrderIds.current.add(order.id));
      if (notify && newOrders.length > 0) playSound();
    } catch (loadError) {
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
        const nextMappings = await getMerchantRestaurants();
        if (nextMappings.length === 0) {
          setError("Ce compte n'est lié à aucun restaurant.");
        } else {
          setMappings(nextMappings);
          // Conserve l'établissement choisi sur l'autre page
          // Lu depuis l'URL côté client : évite d'imposer une
          // frontière Suspense au prérendu.
          const wanted = new URLSearchParams(window.location.search).get("r");
          const match = wanted
            ? nextMappings.find((m) => m.restaurant_id === wanted)
            : undefined;
          setRestaurantId((match ?? nextMappings[0]).restaurant_id);
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
    void loadOrders(false);
    getReceiptSettings(restaurantId).then(setReceiptSettings).catch((settingsError) => {
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

  if (loading) return <main className="min-h-screen bg-stone-100 p-8">Chargement…</main>;

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
