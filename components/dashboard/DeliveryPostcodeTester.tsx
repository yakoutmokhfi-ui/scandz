"use client";

import { useEffect, useRef, useState } from "react";
import { getMerchantDeliveryTestCountries, testMerchantDeliveryPostcode, type DeliveryPostcodeResult } from "@/lib/services/dashboard";
import { translate, type Lang } from "@/lib/i18n";

export default function DeliveryPostcodeTester({ restaurantId, revision, lang }: { restaurantId: string; revision: number; lang: Lang }) {
  const [postal, setPostal] = useState("");
  const [country, setCountry] = useState("");
  const [countries, setCountries] = useState<Array<{ code: string; name: string }>>([]);
  const [subtotal, setSubtotal] = useState("0");
  const [quantity, setQuantity] = useState("1");
  const [result, setResult] = useState<DeliveryPostcodeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const t = (key: string) => translate(lang, key);
  useEffect(() => {
    let current = true;
    void getMerchantDeliveryTestCountries(restaurantId).then((next) => {
      if (!current) return;
      setCountries(next ?? []);
      setCountry(next?.length === 1 ? next[0].code : "");
    }).catch(() => { if (current) setError(translate(lang, "dpLoadFailed")); });
    return () => { current = false; sequence.current += 1; };
  }, [restaurantId, lang]);
  useEffect(() => { sequence.current += 1; setResult(null); setBusy(false); setError(null); }, [revision]);
  function invalidate() { sequence.current += 1; setResult(null); setError(null); setBusy(false); }
  async function run() {
    const token = ++sequence.current;
    const amount = Number(subtotal.replace(",", ".")), count = Number(quantity);
    if (!subtotal.trim() || !quantity.trim() || !Number.isFinite(amount) || amount < 0 || !Number.isInteger(count) || count < 0) {
      setError(t("dpInvalidCart")); return;
    }
    setBusy(true); setError(null); setResult(null);
    try {
      const next = await testMerchantDeliveryPostcode({ restaurantId, postalCode: postal, countryCode: country || null, subtotal: amount, totalCount: count });
      if (token === sequence.current) setResult(next);
    } catch { if (token === sequence.current) setError(t("dpTestFailed")); }
    finally { if (token === sequence.current) setBusy(false); }
  }
  return <section className="mt-6 rounded-2xl border border-stone-300 bg-stone-50 p-4" aria-labelledby="postcode-test-title">
    <h3 id="postcode-test-title" className="font-bold">{t("dpTestTitle")}</h3>
    <p className="mt-1 text-sm text-stone-600">{t("dpTestHint")}</p>
    <form onSubmit={(e) => { e.preventDefault(); void run(); }} className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-sm">{t("dpPostcode")}<input required value={postal} onChange={(e) => { invalidate(); setPostal(e.target.value); }} className="mt-1 w-full rounded-xl border p-2" /></label>
      {countries.length > 1 && <label className="text-sm">{t("dpCountry")}<select required value={country} onChange={(e) => { invalidate(); setCountry(e.target.value); }} className="mt-1 w-full rounded-xl border p-2"><option value="">—</option>{countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>}
      <label className="text-sm">{t("dpCartAmount")}<input type="number" required min="0" step="0.01" value={subtotal} onChange={(e) => { invalidate(); setSubtotal(e.target.value); }} className="mt-1 w-full rounded-xl border p-2" /></label>
      <label className="text-sm">{t("dpCartCount")}<input type="number" required min="0" step="1" value={quantity} onChange={(e) => { invalidate(); setQuantity(e.target.value); }} className="mt-1 w-full rounded-xl border p-2" /></label>
      <button disabled={busy} className="rounded-xl bg-stone-900 px-4 py-2 font-bold text-white disabled:opacity-50">{busy ? t("dpTesting") : t("dpTest")}</button>
    </form>
    <div aria-live="polite" className="mt-3 text-sm">
      {error && <p role="alert">{error}</p>}
      {result && result.status !== "resolved" && <p>{t(`dpTestStatus_${result.status}`)}</p>}
      {result?.status === "resolved" && <>
        <p className="font-bold">{result.eligible ? t("dpEligible") : t("dpNotEligible")}</p>
        {result.fulfillment_rule_id && <dl className="mt-2 grid grid-cols-2 gap-2">
          <dt>{t("dpZoneName")}</dt><dd>{result.fulfillment_code}</dd>
          <dt>{t("dpMatchedPrefix")}</dt><dd>{result.matched_prefix ?? "—"}</dd>
          <dt>{t("dpFallback")}</dt><dd>{result.is_fallback ? t("dpYes") : t("dpNo")}</dd>
          <dt>{t("dpCalculatedFee")}</dt><dd>{result.delivery_fee == null ? "—" : Number(result.delivery_fee).toFixed(2)}</dd>
          <dt>{t("dpProvider")}</dt><dd>{result.provider === "internal" ? t("dpInternal") : result.provider === "other_external" ? t("dpOtherProvider") : result.provider}</dd>
        </dl>}
        {result.block && <p className="mt-2">{t(`dpTestBlock_${result.block}`)}{result.missing != null ? ` (${result.missing})` : ""}</p>}
        {result.customer_text && <p className="mt-2">{result.customer_text}</p>}
      </>}
    </div>
  </section>;
}
