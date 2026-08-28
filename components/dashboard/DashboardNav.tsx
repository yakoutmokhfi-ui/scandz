"use client";

import { usePathname, useRouter } from "next/navigation";
import { signOut } from "@/lib/services/auth";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { translate, type Lang } from "@/lib/i18n";
import { publicMenuHref as getPublicMenuHref } from "@/lib/dashboard-nav";

/**
 * Barre de navigation partagée par les pages commerçant.
 *
 * Collée en haut et toujours visible : le commerçant passe des
 * commandes à sa carte sans jamais dépendre du bouton retour du
 * navigateur, y compris sur un téléphone tenu d'une main.
 *
 * L'établissement sélectionné est transmis dans l'URL, ce qui le
 * conserve d'une page à l'autre.
 */
export default function DashboardNav({
  restaurantName,
  restaurantId,
  mappings,
  onSelectRestaurant,
  staffLanguage = "fr",
  children,
}: {
  restaurantName: string;
  restaurantId: string;
  mappings: MerchantRestaurant[];
  onSelectRestaurant: (id: string) => void;
  staffLanguage?: string;
  /** Actions propres à la page (son, historique…) */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const onCatalogue = pathname?.startsWith("/dashboard/catalogue");
  const onSettings = pathname?.startsWith("/dashboard/settings");
  /** Corrige L1B-02 (contre-audit Work, tour 1B.1) : sans cet état
   *  dédié, l'onglet "Commandes" (repli générique !onCatalogue &&
   *  !onSettings) se marquait à tort actif sur /dashboard/translations
   *  -- reproduit avant correction. */
  const onTranslations = pathname?.startsWith("/dashboard/translations");
  // Onglet "Tarifs de livraison" (Dashboard Delivery Pricing v1) : même
  // patron que onTranslations ci-dessus -- exclu explicitement du repli
  // générique de l'onglet "Commandes" pour ne pas reproduire L1B-02.
  const onDeliveryPricing = pathname?.startsWith("/dashboard/delivery-pricing");
  // Onglet "Paiement" (Dashboard Payment Module v1, PAYMENT P2B-B) :
  // même patron que onDeliveryPricing/onTranslations ci-dessus --
  // exclu explicitement du repli générique de l'onglet "Commandes"
  // pour ne pas reproduire L1B-02.
  const onPayment = pathname?.startsWith("/dashboard/payment");
  const t = (k: string) => translate(staffLanguage as Lang, k);

  const href = (base: string) =>
    restaurantId ? `${base}?r=${restaurantId}` : base;

  // Dérivé de `mappings` (jamais codé en dur) : c'est la même source
  // que le sélecteur d'établissement ci-dessous. `null` tant que
  // l'établissement courant n'a pas de slug exploitable — le bouton
  // "Voir le menu" reste alors masqué plutôt que de générer
  // /r/undefined ou /r/null (voir lib/dashboard-nav.ts).
  const publicMenuHref = getPublicMenuHref(restaurantId, mappings);

  async function logout() {
    await signOut();
    router.replace("/dashboard/login");
  }

  const tab = (active: boolean) =>
    "flex-1 rounded-xl px-4 py-2.5 text-center text-sm font-bold sm:flex-none " +
    (active
      ? "bg-stone-900 text-white"
      : "border border-stone-300 bg-white text-stone-800");

  return (
    <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-widest text-amber-700">
              Scanym commerçant
            </p>
            <h1 className="truncate text-xl font-black text-stone-900">
              {restaurantName}
            </h1>
          </div>

          <div className="flex flex-wrap gap-2">
            {mappings.length > 1 && (
              <select
                value={restaurantId}
                onChange={(e) => onSelectRestaurant(e.target.value)}
                className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
              >
                {mappings.map((m) => (
                  <option key={m.restaurant_id} value={m.restaurant_id}>
                    {m.restaurants?.name ?? m.restaurant_id}
                  </option>
                ))}
              </select>
            )}
            {publicMenuHref && (
              <a
                href={publicMenuHref}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-800"
              >
                {t("dsViewMenu")}
              </a>
            )}
            {children}
            <button
              onClick={logout}
              className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm font-bold text-stone-800"
            >
              {t("dsLogout")}
            </button>
          </div>
        </div>

        {/* Onglets : pleine largeur sur mobile, accessibles au pouce.
            `flex-wrap` (PAY-P2B-B-03, contre-audit Work) : avec six
            onglets, une seule ligne sans retour à la ligne risquait de
            déborder/écraser le texte sur petit écran -- même
            convention `flex-wrap` déjà utilisée juste au-dessus dans ce
            même fichier (lignes "Scanym commerçant" / sélecteur
            établissement), pas un nouveau motif. Aucun onglet ne
            devient inaccessible : tout reste dans le flux normal du
            document (pas de overflow-hidden/scroll), donc atteignable
            au clavier comme au clic quel que soit le nombre de
            lignes. */}
        <nav className="mt-3 flex flex-wrap gap-2">
          <a
            href={href("/dashboard")}
            className={tab(
              !onCatalogue && !onSettings && !onTranslations && !onDeliveryPricing && !onPayment
            )}
          >
            {t("dsOrders")}
          </a>
          <a href={href("/dashboard/catalogue")} className={tab(!!onCatalogue)}>
            {t("mcTitle")}
          </a>
          <a href={href("/dashboard/settings")} className={tab(!!onSettings)}>
            {t("mcSettings")}
          </a>
          <a href={href("/dashboard/delivery-pricing")} className={tab(!!onDeliveryPricing)}>
            {t("dsDeliveryPricing")}
          </a>
          <a href={href("/dashboard/payment")} className={tab(!!onPayment)}>
            {t("dsPayment")}
          </a>
          <a href={href("/dashboard/translations")} className={tab(!!onTranslations)}>
            {t("dsTranslations")}
          </a>
        </nav>
      </div>
    </header>
  );
}
