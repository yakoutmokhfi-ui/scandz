import { useI18n } from "@/lib/i18n-context";
import { tName } from "@/lib/menu-i18n";
import type { MenuCategory } from "@/lib/types";

/**
 * Navigation par catégories, en tête de la section claire.
 *
 * Chaque entrée présente une icône sous une arche, le libellé, puis
 * un indicateur horizontal — long et doré pour la catégorie active,
 * court et discret sinon.
 *
 * Quatre entrées tiennent simultanément sur un écran de téléphone.
 * Au-delà, la bande défile horizontalement ; le défilement reste
 * confiné à cette zone et n'entraîne jamais la page entière.
 *
 * L'état actif ne repose pas uniquement sur la couleur : il combine
 * la graisse du texte, la longueur de l'indicateur et `aria-pressed`.
 */
export default function CategoryNav({
  categories,
  activeId,
  onSelect,
  variant = "classic",
}: {
  categories: MenuCategory[];
  activeId: string;
  onSelect: (id: string) => void;
  variant?: "classic" | "editorial";
}) {
  const { lang, sourceLanguage } = useI18n();

  // Format historique conservé pour Illico Presto, Sanaa et les
  // futurs établissements tant qu'un template n'a pas été choisi.
  if (variant === "classic") {
    return (
      <nav className="sticky top-0 z-30 border-b border-espresso/10 bg-crema/95 backdrop-blur">
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {categories.map((category) => {
            const isActive = category.id === activeId;
            return (
              <button
                key={category.id}
                onClick={() => onSelect(category.id)}
                aria-pressed={isActive}
                className={
                  "flex-1 basis-[8rem] rounded-xl px-4 py-3 text-center text-sm font-semibold transition-colors " +
                  (isActive
                    ? "bg-caramel text-caramel-ink shadow-sm"
                    // Corrige UIFIX-01 : l'ancien fond blanc était un
                    // fond LITTÉRAL figé, totalement déconnecté du
                    // thème, alors que text-ink-on-bg est calculé pour
                    // rester lisible contre --sc-bg (le fond de page,
                    // personnalisable). Si un commerçant choisit un
                    // bg_color sombre, ce calcul résout vers du texte
                    // BLANC -- posé sur un fond resté littéralement
                    // blanc : texte invisible. bg-crema (= var(--sc-bg))
                    // rétablit la même source pour le fond et pour le
                    // calcul du texte, comme c'est déjà le cas pour
                    // bg-caramel/text-caramel-ink
                    // ci-dessus.
                    : "bg-crema text-ink-on-bg shadow-sm")
                }
              >
                {tName(category, lang, sourceLanguage)}
              </button>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <nav className="sticky top-0 z-30 border-b border-espresso/10 bg-crema/95 backdrop-blur">
      <div className="scrollbar-none overflow-x-auto overscroll-x-contain">
        <ul className="flex min-w-full gap-1 px-2 py-2">
          {categories.map((category) => {
            const isActive = category.id === activeId;
            const label = tName(category, lang, sourceLanguage);
            return (
              <li key={category.id} className="min-w-[5.5rem] flex-1">
                <button
                  onClick={() => onSelect(category.id)}
                  aria-pressed={isActive}
                  className="flex w-full flex-col items-center gap-1 rounded-lg px-2 py-1.5"
                >
                  {/* Arche : demi-cercle ouvert vers le bas */}
                  <span
                    aria-hidden
                    className={
                      "flex h-9 w-9 items-end justify-center rounded-t-full border border-b-0 pb-1 text-base " +
                      (isActive
                        ? "border-gold bg-gold/10"
                        : "border-espresso/15")
                    }
                  >
                    <CategoryIcon label={label} />
                  </span>

                  <span
                    className={
                      "text-center text-[0.7rem] leading-tight " +
                      (isActive
                        ? "font-bold text-ink-on-bg"
                        : "font-medium text-ink-on-bg-muted")
                    }
                  >
                    {label}
                  </span>

                  {/* Indicateur : long et doré si actif */}
                  <span
                    aria-hidden
                    className={
                      "h-0.5 rounded-full transition-all " +
                      (isActive ? "w-8 bg-gold" : "w-3 bg-espresso/20")
                    }
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

/**
 * Pictogramme monochrome déduit du libellé existant. Les tracés SVG
 * utilisent currentColor afin de suivre la palette du template et
 * d'éviter les emoji colorés imposés par le système d'exploitation.
 *
 * Le modèle de données ne possède pas encore de clé d'icône. Le
 * pictogramme générique reste donc le repli pour tout libellé non
 * reconnu, sans altérer les données ni le schéma SQL.
 */
function CategoryIcon({ label }: { label: string }) {
  const l = label.toLowerCase();
  let paths;

  if (/cocktail|apéritif|aperitif/.test(l)) {
    paths = <><path d="M5 4h14l-7 8Z" /><path d="M12 12v6M9 20h6" /></>;
  } else if (/smoothie|jus|juice|عصير/.test(l)) {
    paths = <><path d="M7 7h10l-1 13H8Z" /><path d="m13 7 2-4h3M9 11h6" /></>;
  } else if (/café|cafe|thé|the|coffee|tea|قهوة|شاي/.test(l)) {
    paths = <><path d="M5 9h11v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z" /><path d="M16 11h1a3 3 0 0 1 0 6h-1M8 5c0 1 1 1 1 2M12 4c0 1 1 1 1 2" /></>;
  } else if (/en-cas|snack|sandwich|وجبات/.test(l)) {
    paths = <><path d="M4 17h16M6 17a6 6 0 0 1 12 0M12 8V6M10 6h4" /></>;
  } else if (/formule|petit-déjeuner|breakfast|فطور/.test(l)) {
    paths = <><circle cx="12" cy="13" r="6" /><path d="M12 3v2M4.9 5.9l1.4 1.4M19.1 5.9l-1.4 1.4M3 13H1M23 13h-2" /></>;
  } else if (/viennoiser|croissant|معجنات/.test(l)) {
    paths = <><path d="M5 17c3-1 3-9 7-9s4 8 7 9" /><path d="M5 17c-2-2-2-5 0-7M19 17c2-2 2-5 0-7M8 16l-2-5M16 16l2-5" /></>;
  } else if (/pâtisser|patisser|dessert|حلوي/.test(l)) {
    paths = <><path d="M5 11h14v9H5Z" /><path d="M7 11c0-3 2-5 5-5s5 2 5 5M12 6V3M10 3h4" /><path d="M5 16h14" /></>;
  } else if (/cookie|biscuit/.test(l)) {
    paths = <><circle cx="12" cy="12" r="8" /><circle cx="9" cy="9" r=".7" fill="currentColor" stroke="none" /><circle cx="14.5" cy="10.5" r=".7" fill="currentColor" stroke="none" /><circle cx="11" cy="15" r=".7" fill="currentColor" stroke="none" /><circle cx="16" cy="15.5" r=".7" fill="currentColor" stroke="none" /></>;
  } else if (/fondant|chocolat|شوكولا/.test(l)) {
    paths = <><rect x="5" y="4" width="14" height="16" rx="1" /><path d="M12 4v16M5 9h14M5 15h14" /></>;
  } else {
    paths = <><path d="M4 18h16M6 18a6 6 0 0 1 12 0M12 9V7M10 7h4" /></>;
  }

  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths}
    </svg>
  );
}
