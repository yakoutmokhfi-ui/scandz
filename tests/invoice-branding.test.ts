import { test } from "node:test";
import assert from "node:assert/strict";
import {
  invoiceLogoPath,
  loadInvoiceBranding,
} from "../lib/server/invoices/branding.ts";
const rid = "20000000-0000-4000-8000-000000000001";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://synthetic.supabase.co";
const prefix = `https://synthetic.supabase.co/storage/v1/object/public/establishment-assets/${rid}/logo/`;
test("logo restricted to tenant logo bucket on configured project, no URL fetch/redirect", () => {
  assert.equal(
    invoiceLogoPath(prefix + "image.png", rid),
    `${rid}/logo/image.png`,
  );
  for (const url of [
    prefix + "a.svg",
    prefix + "../cover/a.png",
    prefix + "a.png?x=1",
    prefix + "a.png#x",
    prefix + "%2e%2e.png",
    prefix.replace(rid, "foreign") + "a.jpg",
    prefix.replace("synthetic.supabase.co", "evil.test") + "a.png",
  ])
    assert.equal(invoiceLogoPath(url, rid), null, url);
});
test("branding reads only correct restaurant and downloads only its own object", async () => {
  let downloaded = "";
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(80, 16);
  png.writeUInt32BE(80, 20);
  const client: any = {
    from: (table: string) => {
      assert.equal(table, "restaurant_configs");
      return {
        select: () => ({
          eq: (key: string, id: string) => {
            assert.equal(key, "restaurant_id");
            assert.equal(id, rid);
            return {
              maybeSingle: async () => ({
                data: {
                  logo_url: prefix + "image.png",
                  public_phone: "+33 1 23 45 67 89",
                },
                error: null,
              }),
            };
          },
        }),
      };
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, "establishment-assets");
        return {
          download: async (key: string) => {
            downloaded = key;
            return { data: new Blob([png]), error: null };
          },
        };
      },
    },
  };
  const result = await loadInvoiceBranding(rid, client);
  assert.equal(downloaded, `${rid}/logo/image.png`);
  assert.deepEqual(result.logo, png);
  assert.equal(result.phone, "+33 1 23 45 67 89");
});
test("branding absent or failed falls back without exposing URL or failing invoice", async () => {
  const c: any = {
    from: () => {
      throw Error("database unavailable");
    },
  };
  assert.deepEqual(await loadInvoiceBranding(rid, c), {
    logo: null,
    phone: null,
  });
});
