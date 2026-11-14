import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface InvoiceBranding {
  logo: Buffer | null;
  phone: string | null;
}
/** Read only the current tenant's existing logo. No arbitrary URL is fetched. */
export function invoiceLogoPath(
  url: unknown,
  restaurantId: string,
): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url),
      project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    if (
      u.origin !== project.origin ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return null;
    const prefix = `/storage/v1/object/public/establishment-assets/${restaurantId}/logo/`;
    if (!u.pathname.startsWith(prefix)) return null;
    const filename = u.pathname.slice(prefix.length);
    if (!/^[a-zA-Z0-9_-]+\.(png|jpe?g)$/i.test(filename)) return null;
    return `${restaurantId}/logo/${filename}`;
  } catch {
    return null;
  }
}
export async function loadInvoiceBranding(
  restaurantId: string,
  client: SupabaseClient,
): Promise<InvoiceBranding> {
  const empty = { logo: null, phone: null };
  try {
    const { data, error } = await client
      .from("restaurant_configs")
      .select("logo_url,public_phone")
      .eq("restaurant_id", restaurantId)
      .maybeSingle();
    if (error || !data) return empty;
    const phone =
      typeof data.public_phone === "string" &&
      /^[+()\d .-]{3,40}$/.test(data.public_phone)
        ? data.public_phone
        : null;
    const key = invoiceLogoPath(data.logo_url, restaurantId);
    if (!key) return { logo: null, phone };
    const file = await client.storage
      .from("establishment-assets")
      .download(key);
    if (file.error || !file.data || file.data.size > 512_000)
      return { logo: null, phone };
    const logo = Buffer.from(await file.data.arrayBuffer());
    // PDFKit accepts raster PNG/JPEG, never SVG, external links or scripts.
    const png = logo
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = logo[0] === 255 && logo[1] === 216 && logo[2] === 255;
    if (!png && !jpeg) return { logo: null, phone };
    if (
      png &&
      (logo.length < 24 ||
        logo.readUInt32BE(16) > 2000 ||
        logo.readUInt32BE(20) > 2000)
    )
      return { logo: null, phone };
    return { logo, phone };
  } catch {
    return empty;
  }
}
