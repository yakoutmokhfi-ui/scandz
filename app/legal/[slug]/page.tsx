import { notFound } from "next/navigation";
import { getRestaurantPublicCgv } from "@/lib/services/legal-cgv";

/**
 * SELLER LEGAL PROFILE + CGV ENGINE v1 -- Phase 1, Section L.
 *
 * Page légale publique cliente : affiche la version CGV actuellement
 * publiée du marchand désigné par `slug`. Reçoit son contenu de
 * `get_restaurant_public_cgv` (RPC SECURITY DEFINER, tenant-safe --
 * jamais d'exposition cross-tenant, voir
 * DRAFT-lot-seller-legal-profile-cgv-engine-v1.sql section L).
 *
 * Referme le "FUTURE LEGAL TODO" laissé par SADFP-02 CORRECTION v2
 * (components/CartPanel.tsx) : ce lot ajoute enfin une page légale
 * réelle, ce qui permet de réintroduire la case d'acquittement au
 * checkout (voir CartPanel.tsx / MenuView.tsx).
 *
 * Ne change rien pour un marchand sans CGV publiée : 404 explicite,
 * jamais une page vide ou un contenu générique inventé.
 */
export const revalidate = 60;

export default async function PublicLegalPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const cgv = await getRestaurantPublicCgv(slug);

  if (!cgv) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
      {/*
        CGV DOCUMENT PRESENTATION v1 -- la classe `cgv-document`
        (app/globals.css) porte TOUTE la mise en page du document :
        hiérarchie des titres, numérotation des chapitres, espacements,
        séparateurs discrets, bloc d'identité étiqueté, encadré
        réglementaire et repli mobile (aucun débordement horizontal,
        césure sûre des identifiants et des URL).

        Elle s'applique aussi bien aux versions publiées APRÈS ce lot
        (numéros de chapitre présents dans le DOM) qu'aux versions
        publiées AVANT, restées immuables en base (numérotation rendue
        par compteur CSS) -- aucune version publiée n'est réécrite.

        `prose` est retiré volontairement : la typographie du document
        légal est désormais définie ici, sans dépendre d'un préréglage
        éditorial pensé pour des articles.
      */}
      <article
        className="cgv-document"
        // Contenu produit exclusivement par lib/legal/render.ts
        // (déterministe, gabarit Scanym-contrôlé + paramètres
        // marchand approuvés) puis stocké immuable en base -- jamais
        // du texte libre saisi par le marchand ou par un tiers.
        dangerouslySetInnerHTML={{ __html: cgv.renderedContent }}
      />
      <p className="mt-10 border-t border-stone-200 pt-4 text-xs text-stone-500">
        Version publiée le {new Date(cgv.publishedAt).toLocaleDateString("fr-FR")} — référence {cgv.cgvVersionId}
      </p>
    </div>
  );
}
