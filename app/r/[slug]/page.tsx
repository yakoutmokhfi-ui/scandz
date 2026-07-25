import { notFound } from "next/navigation";
import { getRestaurantBySlug } from "@/lib/services/restaurant";
import MenuView from "@/components/MenuView";

// Le menu change rarement : on met la page en cache 60 s.
export const revalidate = 60;

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const restaurant = await getRestaurantBySlug(slug);

  if (!restaurant) {
    notFound();
  }

  return <MenuView restaurant={restaurant} />;
}
