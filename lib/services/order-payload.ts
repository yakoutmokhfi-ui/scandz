import type { CartLine, OrderContext } from "@/lib/whatsapp";
import { formatAddress, formatCustomerDisplayName } from "@/lib/customer";
import type { Lang } from "@/lib/i18n";
import { orderNotePayload } from "@/lib/order-note";

/** Charge exacte envoyée à la RPC Postgres `create_order`. */
export interface CreateOrderPayload {
  p_slug: string;
  p_service_mode: OrderContext["mode"];
  p_items: { menu_item_id: string; quantity: number; option_item_id: string | null }[];
  p_table_number: number | null;
  /** Coordonnées client, ou objet vide en mode "table". Reste un
   *  simple objet JSON transmis tel quel à la RPC : la validation de
   *  forme est faite côté serveur (create_order), pas ici. */
  p_customer: Record<string, string | null | undefined>;
  p_note: string | null;
  p_language: Lang;
  /**
   * SELLER LEGAL PROFILE + CGV ENGINE v1 -- signal de consentement
   * UNIQUEMENT (le client a coché la case). Ni la version CGV
   * acceptée, ni son hash ne transitent jamais par ce payload : le
   * serveur (create_order) résout lui-même la version active du
   * marchand et son hash -- CRITICAL TRUST RULE, voir
   * DRAFT-lot-seller-legal-profile-cgv-engine-v1.sql. Absent/false
   * est sans effet pour un marchand qui n'est pas CGV_ACTIVE (aucune
   * régression du comportement existant).
   */
  p_cgv_accepted: boolean;
}

/**
 * Construit la charge de `create_order` à partir de l'état du panier.
 *
 * Fonction pure (aucun accès réseau, aucune dépendance à Supabase) :
 * extraite de `createOrder` pour rester testable par `npm test` sans
 * variables d'environnement Supabase. `createOrder` (lib/services/orders.ts)
 * appelle cette fonction puis se contente de transmettre le résultat
 * à `supabase.rpc(...)`.
 */
export function buildCreateOrderPayload(params: {
  slug: string;
  context: OrderContext;
  lines: CartLine[];
  lang: Lang;
  note?: string | null;
  /** Défaut false : un appelant qui ne transmet rien (comportement
   *  historique, avant ce lot) obtient exactement le même résultat
   *  qu'avant pour un marchand non CGV_ACTIVE, et est bloqué serveur
   *  (jamais silencieusement autorisé) pour un marchand CGV_ACTIVE. */
  cgvAccepted?: boolean;
}): CreateOrderPayload {
  const { slug, context, lines, lang, note, cgvAccepted } = params;

  const items = lines.map((l) => ({
    menu_item_id: l.item.id,
    quantity: l.quantity,
    option_item_id: l.option ? l.option.id : null,
  }));

  const customer =
    context.mode === "table"
      ? {}
      : {
          // CUSTOMER FOLLOW-UP + TRACKING EMAIL v1 -- `name` reste la
          // SEULE clé consommée par les modes non suivis (room_service /
          // click_collect, champ backend `customer_name`), inchangée
          // pour eux. Pour un mode suivi, elle porte désormais le nom
          // d'affichage COMPOSÉ, calculé par la même règle que le
          // serveur : create_order RECOMPOSE de toute façon la valeur
          // à partir de first_name/last_name et ignore celle-ci dès
          // qu'au moins l'un des deux est fourni -- le client ne peut
          // donc jamais faire diverger le nom persisté de sa saisie.
          name: formatCustomerDisplayName(context.customer) || null,
          // Transmis pour la VALIDATION serveur (exigences effectives)
          // et la composition du nom -- jamais persistés séparément :
          // aucune colonne first_name/last_name n'existe sur
          // public.orders, et le mandat en interdit l'ajout.
          first_name: context.customer.firstName?.trim() || null,
          last_name: context.customer.lastName?.trim() || null,
          phone: context.customer.phone || null,
          email: context.customer.email || null,
          address:
            context.mode === "delivery" ? formatAddress(context.customer) : null,
          // SADFP-01 (correction) : code postal STRUCTURÉ, transmis tel
          // quel -- jamais dérivé de `address`/`formatAddress` ni d'une
          // regex. C'est la SEULE source que le serveur (create_order,
          // nouveau moteur) doit utiliser pour router la livraison ;
          // `address` reste un texte d'affichage/stockage uniquement.
          postalCode:
            context.mode === "delivery"
              ? context.customer.postalCode?.trim() || null
              : null,
          // PAYMENT P3-B6 : rue/ville STRUCTURÉES, transmises telles
          // quelles en plus de `address` (qui reste le texte d'affichage
          // combiné, INCHANGÉ) -- jamais dérivées/re-découpées d'`address`
          // ni d'une regex (mandat section 13 : "Do not parse a flattened
          // address later to reconstruct structure"). Auparavant saisies
          // par le client mais jamais transmises au serveur, qui les
          // perdait silencieusement ; corrigé pour permettre au futur
          // contexte de facturation Monetico ("delivery_reuse") de
          // réutiliser une donnée réellement structurée.
          street:
            context.mode === "delivery"
              ? context.customer.street?.trim() || null
              : null,
          city:
            context.mode === "delivery"
              ? context.customer.city?.trim() || null
              : null,
        };

  return {
    p_slug: slug,
    p_service_mode: context.mode,
    p_items: items,
    p_table_number: context.mode === "table" ? context.tableNumber : null,
    p_customer: customer,
    p_note: orderNotePayload(note),
    p_language: lang,
    p_cgv_accepted: cgvAccepted === true,
  };
}
