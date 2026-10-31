"use client";

import { usePathname, useRouter } from "next/navigation";
import { signOut } from "@/lib/services/auth";
import type { MerchantRestaurant } from "@/lib/dashboard-types";
import { translate, type Lang } from "@/lib/i18n";
import { publicMenuHref as getPublicMenuHref, buildRestaurantSelectorModel } from "@/lib/dashboard-nav";

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
  // Onglet "CGV" (Seller Legal Profile + CGV Engine v1) : même patron
  // que les onglets ci-dessus -- exclu explicitement du repli
  // générique de l'onglet "Commandes" pour ne pas reproduire L1B-02.
  const onLegalCgv = pathname?.startsWith("/dashboard/legal-cgv");
  // Onglet "Mise à disposition" (CSDJ-BO-1) : même patron que les
  // onglets ci-dessus -- exclu explicitement du repli générique de
  // l'onglet "Commandes" pour ne pas reproduire L1B-02.
  const onAvailability = pathname?.startsWith("/dashboard/availability");
  const onEmail = pathname?.startsWith("/dashboard/email");
  const t = (k: string) => translate(staffLanguage as Lang, k);

  const href = (base: string) =>
    restaurantId ? `${base}?r=${restaurantId}` : base;

  // Dérivé de `mappings` (jamais codé en dur) : c'est la même source
  // que le sélecteur d'établissement ci-dessous. `null` tant que
  // l'établissement courant n'a pas de slug exploitable — le bouton
  // "Voir le menu" reste alors masqué plutôt que de générer
  // /r/undefined ou /r/null (voir lib/dashboard-nav.ts).
  const publicMenuHref = getPublicMenuHref(restaurantId, mappings);

  /**
   * CONTEXT HARDENING v1 (§17) -- le sélecteur ne doit JAMAIS annoncer
   * un établissement différent de celui sur lequel la page travaille.
   * En contexte opérateur (établissement hors rattachements), aucune
   * option ne correspondait et le navigateur retombait sur la PREMIÈRE
   * option : le sélecteur affichait "Sanaa" pendant que la page
   * travaillait sur "Au lait cru".
   */
  const selectorModel = buildRestaurantSelectorModel({
    restaurantId,
    mappings,
    currentContextName: restaurantName,
  });

  async function logout() {
    await signOut();
    router.replace("/dashboard/login");
  }

  /**
   * CSDJ-BO-1 (revue R2, point 6) -- COMPACTION MOBILE. Avec le 8e
   * onglet, la barre passait à TROIS lignes sur un téléphone de
   * 390 px. Correction : sous `sm`, chaque onglet occupe un quart de
   * la largeur (quatre par ligne, donc deux lignes), avec un texte
   * plus petit et des marges latérales réduites ; au-dessus de `sm`,
   * les classes d'origine reprennent à l'identique (`sm:basis-auto
   * sm:flex-none sm:px-4 sm:text-sm`), donc le bureau est inchangé.
   *
   * Le calcul `calc(25%-0.375rem)` retire la part de `gap-2` (0.5rem)
   * consommée par les trois espaces d'une ligne de quatre.
   *
   * `min-h-11` (44 px) : la cible tactile reste conforme malgré la
   * compaction -- c'est la hauteur, pas la largeur, qui porte
   * l'accessibilité au pouce. Toujours AUCUN défilement horizontal,
   * aucun overflow caché : tout reste dans le flux, atteignable au
   * clavier comme au clic (même garantie que `flex-wrap` en
   * PAY-P2B-B-03).
   */
  const tab = (active: boolean) =>
    "flex min-h-11 flex-1 basis-[calc(25%-0.375rem)] items-center justify-center rounded-xl px-2 py-2.5 text-center text-xs font-bold sm:basis-auto sm:flex-none sm:px-4 sm:text-sm " +
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
            {selectorModel.mode === "select" && (
              <select
                value={restaurantId}
                onChange={(e) => onSelectRestaurant(e.target.value)}
                className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
              >
                {selectorModel.options.map((o) => (
                  <option key={o.restaurantId} value={o.restaurantId}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {selectorModel.mode === "current-context" && (
              // §17 -- contexte consulté hors rattachements : affiché en
              // lecture seule. Jamais un sélecteur qui désignerait un
              // autre établissement que celui réellement chargé.
              <span
                data-current-context={selectorModel.restaurantId}
                className="rounded-xl border border-stone-300 bg-stone-50 px-3 py-2 text-sm font-semibold text-stone-700"
              >
                {selectorModel.label}
              </span>
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
              !onCatalogue && !onSettings && !onTranslations && !onDeliveryPricing && !onPayment && !onLegalCgv && !onAvailability && !onEmail
            )}
          >
            {t("dsOrders")}
          </a>
          <a href={href("/dashboard/catalogue")} className={tab(!!onCatalogue)}>
            {/* CSDJ-BO-1 : libellé court sous `sm`, complet au-dessus. */}
            <span className="sm:hidden">{t("mcTitleShort")}</span>
            <span className="hidden sm:inline">{t("mcTitle")}</span>
          </a>
          <a href={href("/dashboard/settings")} className={tab(!!onSettings)}>
            {t("mcSettings")}
          </a>
          <a href={href("/dashboard/delivery-pricing")} className={tab(!!onDeliveryPricing)}>
            <span className="sm:hidden">{t("dsDeliveryPricingShort")}</span>
            <span className="hidden sm:inline">{t("dsDeliveryPricing")}</span>
          </a>
          {/* CSDJ-BO-1 : placé juste après « Tarifs de livraison », les deux règlent la mise à disposition. */}
          <a href={href("/dashboard/availability")} className={tab(!!onAvailability)}>
            <span className="sm:hidden">{t("dsAvailabilityShort")}</span>
            <span className="hidden sm:inline">{t("dsAvailability")}</span>
          </a>
          <a href={href("/dashboard/payment")} className={tab(!!onPayment)}>
            {t("dsPayment")}
          </a>
          <a href={href("/dashboard/legal-cgv")} className={tab(!!onLegalCgv)}>
            {t("dsLegalCgv")}
          </a>
          <a href={href("/dashboard/translations")} className={tab(!!onTranslations)}>
            <span className="sm:hidden">{t("dsTranslationsShort")}</span>
            <span className="hidden sm:inline">{t("dsTranslations")}</span>
          </a>
          <a href={href("/dashboard/email")} className={tab(!!onEmail)}>
            {t("dsEmailProvider")}
          </a>
        </nav>
      </div>
    </header>
  );
}
